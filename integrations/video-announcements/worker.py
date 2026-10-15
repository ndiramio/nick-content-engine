"""Published Shopify Atom articles -> contact-scoped Brevo automation events.

Standard library only. Sending is disabled unless ANNOUNCEMENTS_ENABLED=true.
No email is sent directly: the Brevo automation must be configured separately.
"""
import contextlib
import datetime as dt
import fcntl
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

FEED = 'https://nickdiramio.com/blogs/clipbreakdown.atom'
ATOM = '{http://www.w3.org/2005/Atom}'


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def log(event, **fields):
    print(json.dumps({'event': event, **fields}), flush=True)


def request(url, key=None, body=None):
    headers = {'User-Agent': 'NickContentEngine-Announcements/1.0'}
    if key:
        headers['api-key'] = key
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=30) as response:
        data = response.read(8_000_001)
        if len(data) > 8_000_000:
            raise ValueError('response_too_large')
        return data


class Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ('style', 'script'):
            self.skip += 1
        if tag in ('p', 'br', 'div', 'li') and not self.skip:
            self.parts.append(' ')

    def handle_endtag(self, tag):
        if tag in ('style', 'script'):
            self.skip = max(0, self.skip - 1)
        if tag in ('p', 'div', 'li') and not self.skip:
            self.parts.append(' ')

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def plain(value):
    parser = Text()
    parser.feed(value or '')
    return ' '.join(''.join(parser.parts).split())


def video_id(content):
    # Prefer the actual embedded episode over incidental YouTube links.
    content = html.unescape(content)
    for pattern in (
        r'https?://(?:www\.)?youtube(?:-nocookie)?\.com/embed/([\w-]{11})(?![\w-])',
        r'https?://(?:www\.)?youtube\.com/watch\?[^\s\"<>]*?v=([\w-]{11})(?![\w-])',
        r'https?://youtu\.be/([\w-]{11})(?![\w-])',
    ):
        match = re.search(pattern, content)
        if match:
            return match[1]
    return None


def parse_feed(data):
    root = ET.fromstring(data)
    if root.tag != ATOM + 'feed':
        raise ValueError('expected_atom_feed')
    result = []
    for entry in root.findall(ATOM + 'entry'):
        content = entry.findtext(ATOM + 'content', '')
        vid = video_id(content)
        links = entry.findall(ATOM + 'link')
        url = next((x.get('href', '') for x in links if x.get('rel') == 'alternate'), '')
        parsed = urllib.parse.urlparse(url)
        if not vid or parsed.scheme != 'https' or parsed.hostname != 'nickdiramio.com' or not parsed.path.startswith('/blogs/clipbreakdown/'):
            continue
        # Prefer the already-written editorial excerpt; never include CSS or markup.
        excerpt = re.sub(r'\s*More\s*$', '', plain(entry.findtext(ATOM + 'summary', ''))).strip()
        if not excerpt:
            continue  # Hold articles without an editorial teaser instead of fabricating one.
        words = excerpt.split()
        excerpt = ' '.join(words[:120]) + ('…' if len(words) > 120 else '')
        title = plain(entry.findtext(ATOM + 'title', ''))
        published = entry.findtext(ATOM + 'published', '')
        try:
            published = dt.datetime.fromisoformat(published.replace('Z', '+00:00'))
            if published.tzinfo is None:
                continue
        except ValueError:
            continue
        if not title or published > dt.datetime.now(dt.timezone.utc):
            continue
        result.append({'video_id': vid, 'published': published.isoformat(), 'data': {
            'video_title': title, 'youtube_url': f'https://www.youtube.com/watch?v={vid}',
            'thumbnail_url': f'https://i.ytimg.com/vi/{vid}/hqdefault.jpg',
            'article_url': url, 'teaser_1': excerpt, 'teaser_2': '',
            'preview_text': excerpt[:150], 'video_id': vid,
        }})
    return result


def database(path):
    db = sqlite3.connect(path)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=FULL')
    db.executescript('''
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS articles (
      video_id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deliveries (
      video_id TEXT NOT NULL, contact_id INTEGER NOT NULL, status TEXT NOT NULL,
      PRIMARY KEY(video_id, contact_id));
    ''')
    return db


def collect(db, articles, timestamp=None):
    timestamp = timestamp or now()
    row = db.execute("SELECT value FROM metadata WHERE key='started_at'").fetchone()
    if row is None:
        with db:
            db.execute("INSERT INTO metadata VALUES ('started_at',?)", (timestamp,))
            for article in articles:
                db.execute('INSERT OR IGNORE INTO articles VALUES (?,?,?)',
                           (article['video_id'], json.dumps(article['data']), 'baseline'))
        return 0
    cutoff = dt.datetime.fromisoformat(row[0])
    count = 0
    with db:
        for article in articles:
            status = 'pending' if dt.datetime.fromisoformat(article['published']) > cutoff else 'baseline'
            cursor = db.execute('INSERT OR IGNORE INTO articles VALUES (?,?,?)',
                                (article['video_id'], json.dumps(article['data']), status))
            count += cursor.rowcount if status == 'pending' else 0
    return count


def api(path, key, body=None):
    raw = request('https://api.brevo.com/v3' + path, key, body)
    return json.loads(raw) if raw else {}


def verified_account(key):
    account = api('/account', key)
    if account.get('email', '').lower() != 'nick@nickdiramio.com':
        raise ValueError('wrong_brevo_account')
    expected = os.environ.get('EXPECTED_BREVO_ORGANIZATION_ID')
    if not expected:
        raise ValueError('brevo_organization_pin_required')
    if str(account.get('organization_id', '')) != expected:
        raise ValueError('wrong_brevo_organization')
    return account


def audience(key, list_id):
    contacts, offset = {}, 0
    while True:
        page = api(f'/contacts/lists/{list_id}/contacts?limit=500&offset={offset}', key)
        rows = page.get('contacts', [])
        for contact in rows:
            if not contact.get('emailBlacklisted', True) and contact.get('email') and contact.get('id'):
                contacts[int(contact['id'])] = contact
        if len(rows) < 500:
            return contacts
        offset += len(rows)


def register_setup_event(db, key, articles):
    """Register fields using only an existing owner contact, once, without a send API."""
    account = verified_account(key)
    state_key = 'setup_event:' + str(account['organization_id'])
    state = db.execute('SELECT value FROM metadata WHERE key=?', (state_key,)).fetchone()
    if state:
        log('setup_event_already_attempted', status=state[0])
        return
    contact = None
    for email in ('nick@nickdiramio.com', 'nickdiramio@gmail.com'):
        try:
            candidate = api('/contacts/' + urllib.parse.quote(email, safe=''), key)
            if candidate.get('id') and candidate.get('email', '').lower() == email:
                contact = candidate
                break
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
    if contact is None:
        raise ValueError('existing_owner_contact_required_for_setup')
    if not articles:
        raise ValueError('setup_article_required')
    data = dict(articles[0]['data'])
    data.update(setup_only=True, announcement_id='setup-preview-v1')
    data['video_title'] = '[Setup preview] ' + data['video_title']
    # Do not retry a potentially accepted event after a timeout or container crash.
    with db:
        db.execute("INSERT INTO metadata VALUES (?,'uncertain')", (state_key,))
    api('/events', key, {'event_name': 'video_announcement_ready',
                        'identifiers': {'contact_id': int(contact['id'])},
                        'event_properties': data})
    with db:
        db.execute("UPDATE metadata SET value='registered' WHERE key=?", (state_key,))
    log('setup_event_registered', setupOnly=True)


def deliver(db, key, list_id, max_events=100):
    verified_account(key)
    recipients = audience(key, list_id)
    for vid, in db.execute("SELECT video_id FROM articles WHERE status='pending'").fetchall():
        with db:
            for cid in recipients:
                db.execute("INSERT OR IGNORE INTO deliveries VALUES (?,?,'ready')", (vid, cid))
            db.execute("UPDATE articles SET status='queued' WHERE video_id=?", (vid,))
    jobs = db.execute("SELECT d.video_id,d.contact_id,a.payload FROM deliveries d JOIN articles a USING(video_id) WHERE d.status='ready' LIMIT ?", (max_events,)).fetchall()
    accepted = 0
    for vid, cid, payload in jobs:
        # Recheck current membership and suppression immediately before the event.
        contact = api(f'/contacts/{cid}', key)
        if contact.get('emailBlacklisted', True) or list_id not in contact.get('listIds', []) or not contact.get('email'):
            with db:
                db.execute("UPDATE deliveries SET status='suppressed' WHERE video_id=? AND contact_id=?", (vid, cid))
            continue
        # A crash/timeout after claiming requires manual reconciliation, not a blind retry.
        with db:
            db.execute("UPDATE deliveries SET status='uncertain' WHERE video_id=? AND contact_id=?", (vid, cid))
        data = json.loads(payload)
        data['setup_only'] = False
        data['announcement_id'] = hashlib.sha256(f'{vid}:{cid}'.encode()).hexdigest()
        api('/events', key, {'event_name': 'video_announcement_ready',
                            'identifiers': {'contact_id': cid}, 'event_properties': data})
        with db:
            db.execute("UPDATE deliveries SET status='accepted' WHERE video_id=? AND contact_id=?", (vid, cid))
        accepted += 1
    return accepted


def main():
    state = Path(os.environ.get('ANNOUNCEMENT_STATE_DIR', '/data'))
    if os.environ.get('RAILWAY_ENVIRONMENT_ID'):
        mount = os.environ.get('RAILWAY_VOLUME_MOUNT_PATH')
        if not mount or not state.resolve().is_relative_to(Path(mount).resolve()):
            raise ValueError('persistent_volume_required')
    state.mkdir(parents=True, exist_ok=True)
    with (state / 'announcements.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with contextlib.closing(database(state / 'announcements.sqlite')) as db:
            articles = parse_feed(request(FEED))
            added = collect(db, articles)
            enabled = os.environ.get('ANNOUNCEMENTS_ENABLED') == 'true'
            if os.environ.get('REGISTER_SETUP_EVENT') == 'true':
                if enabled:
                    raise ValueError('disable_delivery_before_setup')
                key = os.environ.get('BREVO_API_KEY')
                if not key:
                    raise ValueError('brevo_key_required_for_setup')
                register_setup_event(db, key, articles)
            accepted = 0
            if enabled:
                key = os.environ.get('BREVO_API_KEY')
                list_id = int(os.environ.get('BREVO_ANNOUNCEMENT_LIST_ID', '0'))
                if not key or list_id <= 0:
                    raise ValueError('brevo_key_and_confirmed_list_required')
                accepted = deliver(db, key, list_id)
            counts = dict(db.execute('SELECT status,COUNT(*) FROM deliveries GROUP BY status'))
            pending = db.execute("SELECT COUNT(*) FROM articles WHERE status='pending'").fetchone()[0]
            log('announcement_poll_completed', enabled=enabled, feedArticles=len(articles),
                newArticles=added, pendingArticles=pending, acceptedEvents=accepted, deliveryCounts=counts)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # No contact addresses, API keys, article contents, or response bodies in logs.
        log('announcement_poll_failed', errorType=type(error).__name__)
        raise SystemExit(1)
