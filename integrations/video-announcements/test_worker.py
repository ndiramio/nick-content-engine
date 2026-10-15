import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import worker


def article(vid='abcdefghijk', published='2026-10-16T00:00:00+00:00'):
    return {'video_id': vid, 'published': published, 'data': {
        'video_title': 'Test', 'youtube_url': 'https://www.youtube.com/watch?v=' + vid,
        'article_url': 'https://nickdiramio.com/blogs/clipbreakdown/test',
        'thumbnail_url': 'https://i.ytimg.com/vi/' + vid + '/hqdefault.jpg',
        'teaser_1': 'My exact article excerpt.', 'teaser_2': '', 'preview_text': 'My exact article excerpt.'}}


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = worker.database(Path(self.tmp.name) / 'test.sqlite')

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def pending(self):
        worker.collect(self.db, [], '2026-10-15T00:00:00+00:00')
        worker.collect(self.db, [article()])

    def test_baseline_and_old_article_edits_do_not_enqueue(self):
        worker.collect(self.db, [article()], '2026-10-15T00:00:00+00:00')
        worker.collect(self.db, [article(), article('oldoldold01', '2025-01-01T00:00:00+00:00')])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM articles WHERE status='pending'").fetchone()[0], 0)

    def test_new_article_enqueued_once_and_payload_is_frozen(self):
        self.pending()
        changed = article()
        changed['data']['teaser_1'] = 'Edited after publication'
        worker.collect(self.db, [changed])
        rows = self.db.execute('SELECT payload FROM articles').fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(json.loads(rows[0][0])['teaser_1'], 'My exact article excerpt.')

    def test_extracts_episode_and_removes_markup_css_and_more(self):
        xml = '''<feed xmlns="http://www.w3.org/2005/Atom"><entry>
        <title>My title</title><published>2026-01-01T00:00:00Z</published>
        <link rel="alternate" href="https://nickdiramio.com/blogs/clipbreakdown/test"/>
        <content type="html">&lt;iframe src="https://www.youtube.com/embed/abcdefghijk"&gt;&lt;/iframe&gt;</content>
        <summary type="html">&lt;style&gt;.bad{display:none}&lt;/style&gt;My &lt;b&gt;observation&lt;/b&gt;.&lt;p&gt;&lt;a&gt;More&lt;/a&gt;&lt;/p&gt;</summary>
        </entry></feed>'''
        rows = worker.parse_feed(xml)
        self.assertEqual(rows[0]['data']['teaser_1'], 'My observation.')
        self.assertEqual(rows[0]['video_id'], 'abcdefghijk')
        self.assertEqual(worker.parse_feed(xml.replace('/embed/', '/shorts/')), [])
        self.assertEqual(worker.parse_feed(xml.replace('nickdiramio.com/blogs/', 'evil.example/blogs/')), [])

    def mock_api(self, path, key, body=None):
        if path == '/account':
            return {'email': 'nick@nickdiramio.com'}
        if path.startswith('/contacts/lists/'):
            return {'contacts': [{'id': 1, 'email': 'test@example.com', 'emailBlacklisted': False},
                                 {'id': 2, 'email': 'blocked@example.com', 'emailBlacklisted': True}]}
        if path == '/contacts/1':
            return {'id': 1, 'email': 'test@example.com', 'emailBlacklisted': False, 'listIds': [7]}
        if path == '/events':
            return {}
        raise AssertionError(path)

    def test_contact_scoped_event_and_repeat_poll(self):
        self.pending()
        with patch.object(worker, 'api', side_effect=self.mock_api) as api:
            self.assertEqual(worker.deliver(self.db, 'secret', 7), 1)
            self.assertEqual(worker.deliver(self.db, 'secret', 7), 0)
        events = [call for call in api.call_args_list if call.args[0] == '/events']
        self.assertEqual(len(events), 1)
        body = events[0].args[2]
        self.assertEqual(body['identifiers'], {'contact_id': 1})
        self.assertEqual(body['event_name'], 'video_announcement_ready')
        self.assertEqual(body['event_properties']['teaser_1'], 'My exact article excerpt.')

    def test_unsubscribe_between_queue_and_delivery_suppresses(self):
        self.pending()
        def changed(path, key, body=None):
            if path == '/contacts/1':
                return {'emailBlacklisted': True, 'listIds': [7], 'email': 'test@example.com'}
            return self.mock_api(path, key, body)
        with patch.object(worker, 'api', side_effect=changed):
            self.assertEqual(worker.deliver(self.db, 'secret', 7), 0)
        self.assertEqual(self.db.execute('SELECT status FROM deliveries').fetchone()[0], 'suppressed')

    def test_uncertain_event_never_automatically_retries(self):
        self.pending()
        def timeout(path, key, body=None):
            if path == '/events':
                raise TimeoutError()
            return self.mock_api(path, key, body)
        with patch.object(worker, 'api', side_effect=timeout):
            with self.assertRaises(TimeoutError):
                worker.deliver(self.db, 'secret', 7)
        with patch.object(worker, 'api', side_effect=self.mock_api) as api:
            self.assertEqual(worker.deliver(self.db, 'secret', 7), 0)
        self.assertFalse(any(c.args[0] == '/events' for c in api.call_args_list))

    def test_wrong_account_cannot_queue_deliveries(self):
        self.pending()
        with patch.object(worker, 'api', return_value={'email': 'other@example.com'}):
            with self.assertRaisesRegex(ValueError, 'wrong_brevo_account'):
                worker.deliver(self.db, 'secret', 7)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM deliveries').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
