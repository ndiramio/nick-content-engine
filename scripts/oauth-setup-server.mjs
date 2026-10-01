// Temporary, isolated OAuth setup server. Never started by the detector cron.
import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CAPTION_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const equal = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createSetupServer({ baseUrl, channelId, directory, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && base.hostname !== '127.0.0.1') throw new Error('HTTPS required');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const setupToken = randomBytes(32).toString('hex');
  const adminToken = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 30 * 60_000;
  let pending;
  let completed = false;
  const redirectUri = new URL('/oauth/callback', base).href;
  writeFileSync(join(directory, 'setup.json'), JSON.stringify({
    startUrl: new URL(`/start?key=${setupToken}`, base).href, redirectUri, adminToken,
  }), { mode: 0o600 });

  const respond = (res, status, text) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
    res.end(text);
  };
  const request = async (url, options) => {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('Google authorization request failed');
    return response.json();
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, base);
      if (req.method === 'POST' && ['/configure', '/collect'].includes(url.pathname)) {
        if (Date.now() > expiresAt || !equal(req.headers['x-setup-key'], adminToken)) {
          return respond(res, 404, 'Not found.');
        }
        if (url.pathname === '/collect') {
          if (!completed) return respond(res, 409, 'Waiting for YouTube authorization.');
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          return res.end(readFileSync(join(directory, 'tokens.json')));
        }
        if (completed || existsSync(join(directory, 'client.json'))) return respond(res, 409, 'Already configured.');
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 16_384) return respond(res, 413, 'Too large.');
          chunks.push(chunk);
        }
        const config = JSON.parse(Buffer.concat(chunks).toString());
        if (!config.web?.client_id || !config.web?.client_secret || !config.web.redirect_uris?.includes(redirectUri)) {
          return respond(res, 400, 'Invalid client configuration.');
        }
        writeFileSync(join(directory, 'client.json'), JSON.stringify(config), { mode: 0o600 });
        return respond(res, 200, 'Configured.');
      }
      if (req.method !== 'GET') return respond(res, 405, 'Method not allowed.');
      if (url.pathname === '/health') return respond(res, 200, 'Ready.');
      if (Date.now() > expiresAt || completed) return respond(res, 410, 'This sign-in session has ended.');
      if (url.pathname === '/start') {
        if (!equal(url.searchParams.get('key'), setupToken)) return respond(res, 404, 'Not found.');
        const client = JSON.parse(readFileSync(join(directory, 'client.json'), 'utf8')).web;
        if (!client?.client_id || !client?.client_secret || !client.redirect_uris?.includes(redirectUri)) {
          return respond(res, 503, 'Google sign-in is still being configured.');
        }
        const verifier = randomBytes(32).toString('base64url');
        pending = { state: randomBytes(32).toString('hex'), verifier, client,
          expiresAt: Date.now() + 10 * 60_000 };
        const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        for (const [key, value] of Object.entries({ client_id: client.client_id,
          redirect_uri: redirectUri, response_type: 'code', scope: CAPTION_SCOPE,
          access_type: 'offline', prompt: 'consent', state: pending.state,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256' })) auth.searchParams.set(key, value);
        res.writeHead(302, { Location: auth.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        return res.end();
      }
      if (url.pathname !== '/oauth/callback') return respond(res, 404, 'Not found.');
      if (!pending || Date.now() > pending.expiresAt || !equal(url.searchParams.get('state'), pending.state)) {
        return respond(res, 400, 'Invalid or expired sign-in session.');
      }
      const flow = pending;
      pending = undefined; // Each authorization response can be exchanged only once.
      if (url.searchParams.has('error') || !url.searchParams.get('code')) {
        return respond(res, 400, 'Google sign-in was not approved. Open the setup link to try again.');
      }
      const tokens = await request('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: flow.client.client_id,
          client_secret: flow.client.client_secret, redirect_uri: redirectUri,
          code: url.searchParams.get('code'), code_verifier: flow.verifier,
          grant_type: 'authorization_code' }),
      });
      if (!tokens.access_token || !tokens.refresh_token || !tokens.scope?.split(' ').includes(CAPTION_SCOPE)) {
        return respond(res, 400, 'Required caption access was not granted. Please try the setup link again.');
      }
      const channels = await request('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (!channels.items?.some(channel => channel.id === channelId)) {
        return respond(res, 403, 'That account did not authorize the configured YouTube channel. Please try again and select the channel owner.');
      }
      writeFileSync(join(directory, 'tokens.json'), JSON.stringify({
        clientId: flow.client.client_id, clientSecret: flow.client.client_secret,
        refreshToken: tokens.refresh_token, channelId, scope: CAPTION_SCOPE,
      }), { mode: 0o600 });
      completed = true;
      console.log(JSON.stringify({ event: 'youtube_authorized', channelId }));
      return respond(res, 200, 'YouTube connected to Nick Content Engine. You can close this page and return to the chat. Nothing has been published.');
    } catch {
      // Do not log request URLs, authorization codes, tokens, or upstream bodies.
      return respond(res, 500, 'Sign-in could not finish. Return to the chat for help.');
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createSetupServer({ baseUrl: process.env.OAUTH_BASE_URL,
    channelId: process.env.YOUTUBE_CHANNEL_ID, directory: process.env.OAUTH_SETUP_DIR || '/tmp/nce-oauth' });
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => {
    console.log(JSON.stringify({ event: 'oauth_setup_ready' }));
  });
}
