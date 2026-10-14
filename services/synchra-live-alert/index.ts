import { Database } from 'bun:sqlite';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const directory = Bun.env.DATA_DIR || '/data';
mkdirSync(directory, { recursive: true });
const db = new Database(`${directory}/live.sqlite`, { create: true });
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, received INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);');
const origins = new Set(['https://nickdiramio.com', 'https://www.nickdiramio.com']);
const getSettings = () => JSON.parse((db.query('SELECT json FROM settings WHERE id=1').get() as any)?.json || '{}');
const getState = () => JSON.parse((db.query('SELECT json FROM state WHERE id=1').get() as any)?.json || '{"live":false}');
const setState = (state: any) => db.query('INSERT OR REPLACE INTO state VALUES (1,?)').run(JSON.stringify(state));
const json = (data: any, status = 200, headers: any = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const tokenMatches = (candidate: string, expected: string) => { const a = Buffer.from(candidate); const b = Buffer.from(expected); return !!expected && a.length === b.length && timingSafeEqual(a, b); };
const pathValue = (value: any, path: string) => path.split('.').reduce((item, key) => item?.[key], value);
const safeUrl = (value: any) => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; } };
async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 65536) { await reader.cancel(); throw new Error('BODY_TOO_LARGE'); } chunks.push(value); }
  return Buffer.concat(chunks);
}
function verify(request: Request, body: Buffer, secret: string) {
  const id = request.headers.get('webhook-id') || '';
  const timestamp = request.headers.get('webhook-timestamp') || '';
  const signatures = request.headers.get('webhook-signature') || '';
  if (!id || id.length > 256 || id.includes('.') || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || signatures.length > 4096) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  if (key.length < 24 || key.length > 64) return false;
  const digest = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest();
  return signatures.split(/\s+/).some(signature => { const [version, value] = signature.split(','); if (version !== 'v1' || !value) return false; const actual = Buffer.from(value, 'base64'); return actual.length === digest.length && timingSafeEqual(actual, digest); });
}
const adminPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nick's live alert setup</title><style>body{font:16px system-ui;max-width:700px;margin:40px auto;padding:24px;background:#faf7f2;color:#252321}input,button,textarea{font:inherit;padding:10px;margin:6px 0;width:100%;box-sizing:border-box}button{background:#252321;color:white;border:0;border-radius:8px}label{display:block;margin-top:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere}small{display:block}</style><h1>Nick's live alert</h1><p>Paste the webhook URL below into Synchra, create the Generic webhook, then save its signing secret here. Keep your management key private.</p><p id="webhook"></p><form id="setup"><label>Management key<input id="token" type="password" required autocomplete="off"></label><label>Synchra signing secret<input id="secret" type="password" autocomplete="off" placeholder="whsec_..."></label><label>Live event type<input id="liveType" placeholder="Copy the exact type from the received event"></label><label>Offline event type, if Synchra supports one<input id="offlineType"></label><label>Stream URL field path<input id="urlPath" value="data.stream.url"></label><label>Stream title field path<input id="titlePath" value="data.stream.title"></label><label>Safety expiry, hours<input id="hours" type="number" min="0.25" max="24" step="0.25" value="4"></label><small>The expiry is a fallback timer, not stream-end detection. Use Hide banner when ending a stream if no offline event is available.</small><button>Save configuration</button></form><button id="status">Read latest signed event</button><button id="clear">Hide banner now</button><pre id="result" aria-live="polite"></pre><script>const $=id=>document.getElementById(id);$('webhook').textContent=location.origin+'/webhooks/synchra';async function api(path,body){const response=await fetch(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+$('token').value,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});$('result').textContent=JSON.stringify(await response.json(),null,2)}$('setup').onsubmit=async e=>{e.preventDefault();await api('/admin/config',{secret:$('secret').value,liveType:$('liveType').value,offlineType:$('offlineType').value,urlPath:$('urlPath').value,titlePath:$('titlePath').value,hours:Number($('hours').value)});$('secret').value=''};$('status').onclick=()=>api('/admin/status');$('clear').onclick=()=>api('/admin/clear',{});</script></html>`;
export async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true });
  if (url.pathname === '/setup' && request.method === 'GET') return new Response(adminPage, { headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'" } });
  if (url.pathname === '/status' && request.method === 'GET') {
    const state = getState(); const live = state.live === true && Date.now() < state.expiresAt;
    return json(live ? { live, title: state.title, url: state.url, image_url: state.imageUrl || safeUrl(Bun.env.DEFAULT_IMAGE_URL), expiresAt: state.expiresAt } : { live: false }, 200, origins.has(request.headers.get('origin') || '') ? { 'Access-Control-Allow-Origin': request.headers.get('origin'), Vary: 'Origin' } : {});
  }
  if (url.pathname.startsWith('/admin/')) {
    if (!tokenMatches((request.headers.get('authorization') || '').replace(/^Bearer /, ''), Bun.env.ADMIN_TOKEN || '')) return json({ error: 'Unauthorized' }, 401);
    if (url.pathname === '/admin/status' && request.method === 'GET') { const settings = getSettings(); return json({ configured: !!(settings.secret || Bun.env.SYNCHRA_SIGNING_SECRET), liveType: settings.liveType, offlineType: settings.offlineType, state: getState() }); }
    if (url.pathname === '/admin/clear' && request.method === 'POST') { const state = getState(); setState({ ...state, live: false, clearedAt: Date.now() }); return json({ live: false }); }
    if (url.pathname === '/admin/config' && request.method === 'POST') {
      const config = JSON.parse((await readBody(request)).toString());
      const old = getSettings(); const secret = config.secret || old.secret || Bun.env.SYNCHRA_SIGNING_SECRET;
      if (!secret || !/^(whsec_)?[A-Za-z0-9+/]+={0,2}$/.test(secret) || Buffer.from(secret.replace(/^whsec_/, ''), 'base64').length < 24 || Buffer.from(secret.replace(/^whsec_/, ''), 'base64').length > 64) return json({ error: 'A valid Synchra signing secret is required.' }, 400);
      if (!Number.isFinite(config.hours) || config.hours < .25 || config.hours > 24) return json({ error: 'Expiry must be between 0.25 and 24 hours.' }, 400);
      for (const key of ['liveType', 'offlineType', 'urlPath', 'titlePath']) if (typeof config[key] !== 'string' || config[key].length > 256) return json({ error: 'Invalid configuration.' }, 400);
      db.query('INSERT OR REPLACE INTO settings VALUES (1,?)').run(JSON.stringify({ ...config, secret }));
      return json({ saved: true, awaitingSignedEvent: !config.liveType });
    }
    return json({ error: 'Not found' }, 404);
  }
  if (url.pathname !== '/webhooks/synchra') return json({ error: 'Not found' }, 404);
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405, { Allow: 'POST' });
  const settings = getSettings(); const secret = settings.secret || Bun.env.SYNCHRA_SIGNING_SECRET;
  if (!secret) return json({ error: 'Signing secret has not been configured.' }, 503);
  const body = await readBody(request);
  if (!verify(request, body, secret)) return json({ error: 'Invalid webhook signature or timestamp.' }, 401);
  let event; try { event = JSON.parse(body.toString()); } catch { return json({ error: 'Invalid JSON' }, 400); }
  if (event.specversion !== '1.0' || typeof event.id !== 'string' || typeof event.type !== 'string' || typeof event.source !== 'string' || !event.data || typeof event.data !== 'object') return json({ error: 'Expected a CloudEvent.' }, 400);
  const id = request.headers.get('webhook-id')!; const now = Date.now();
  return db.transaction(() => {
    if (db.query('SELECT id FROM events WHERE id=?').get(id)) return json({ accepted: true, duplicate: true });
    const previous = getState(); const eventTime = event.time ? Date.parse(event.time) : now;
    if (!Number.isFinite(eventTime) || eventTime > now + 300000) return json({ error: 'Invalid event time' }, 400);
    const info = { type: event.type, source: event.source, data: event.data, time: event.time, receivedAt: now };
    let state = { ...previous, lastSignedEvent: info };
    if (eventTime >= Math.max(previous.eventTime || 0, previous.clearedAt || 0)) {
      if (settings.offlineType && event.type === settings.offlineType) state = { ...state, live: false, eventTime };
      else if (settings.liveType && event.type === settings.liveType) {
        const streamUrl = safeUrl(pathValue(event, settings.urlPath || 'data.stream.url'));
        if (!streamUrl) { setState(state); return json({ error: 'Configure the HTTPS stream URL field path from the latest signed event.' }, 422); }
        const title = pathValue(event, settings.titlePath || 'data.stream.title');
        state = { ...state, live: true, url: streamUrl, title: typeof title === 'string' ? title.slice(0, 250) : '', imageUrl: safeUrl(event.data?.embed?.image_url) || safeUrl(Bun.env.DEFAULT_IMAGE_URL), eventTime, expiresAt: eventTime + (settings.hours || 4) * 3600000 };
      }
    }
    setState(state);
    db.query('INSERT INTO events VALUES (?,?)').run(id, now);
    db.query('DELETE FROM events WHERE received < ?').run(now - 30 * 86400000);
    return json({ accepted: true, live: state.live === true, needsMapping: !settings.liveType });
  })();
}
if (import.meta.main) Bun.serve({ hostname: '0.0.0.0', port: Number(Bun.env.PORT || 3000), fetch: async request => { try { return await handler(request); } catch (error) { return json({ error: error instanceof Error && error.message === 'BODY_TOO_LARGE' ? 'Body too large' : 'Request failed' }, error instanceof Error && error.message === 'BODY_TOO_LARGE' ? 413 : 500); } } });
