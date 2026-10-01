import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createSetupServer, CAPTION_SCOPE } from '../scripts/oauth-setup-server.mjs';

async function fixture(t, account = 'channel') {
  const directory = mkdtempSync(join(tmpdir(), 'nce-oauth-'));
  const calls = [];
  const server = createSetupServer({ baseUrl: 'https://example.test', channelId: 'channel', directory,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => url.includes('/token')
        ? { access_token: 'test-access', refresh_token: 'test-refresh', scope: CAPTION_SCOPE }
        : { items: [{ id: account }] } };
    } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = JSON.parse(readFileSync(join(directory, 'setup.json')));
  const client = { web: { client_id: 'test-client', client_secret: 'test-secret', redirect_uris: [config.redirectUri] } };
  return { config, calls, client, origin };
}

async function begin(f) {
  const configured = await fetch(`${f.origin}/configure`, { method: 'POST',
    headers: { 'X-Setup-Key': f.config.adminToken }, body: JSON.stringify(f.client) });
  assert.equal(configured.status, 200);
  const url = new URL(f.config.startUrl);
  const response = await fetch(f.origin + url.pathname + url.search, { redirect: 'manual' });
  assert.equal(response.status, 302);
  return new URL(response.headers.get('location'));
}

test('OAuth configuration and token collection require a separate admin secret', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.origin}/configure`, { method: 'POST', body: JSON.stringify(f.client) })).status, 404);
  assert.equal((await fetch(`${f.origin}/start?key=wrong`)).status, 404);
  const auth = await begin(f);
  assert.equal(auth.origin, 'https://accounts.google.com');
  assert.equal(auth.searchParams.get('scope'), CAPTION_SCOPE);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  assert.equal((await fetch(`${f.origin}/oauth/callback?state=wrong&code=x`)).status, 400);
  assert.equal(f.calls.length, 0);
  const callback = `${f.origin}/oauth/callback?state=${auth.searchParams.get('state')}&code=test-code`;
  assert.equal((await fetch(callback)).status, 200);
  assert.equal((await fetch(callback)).status, 410);
  assert.equal(f.calls.length, 2);
  assert.equal((await fetch(`${f.origin}/collect`, { method: 'POST' })).status, 404);
  const collected = await fetch(`${f.origin}/collect`, { method: 'POST', headers: { 'X-Setup-Key': f.config.adminToken } });
  assert.equal((await collected.json()).refreshToken, 'test-refresh');
});

test('OAuth refuses to save tokens for a different channel', async t => {
  const f = await fixture(t, 'wrong-channel');
  const auth = await begin(f);
  const response = await fetch(`${f.origin}/oauth/callback?state=${auth.searchParams.get('state')}&code=test-code`);
  assert.equal(response.status, 403);
  const collected = await fetch(`${f.origin}/collect`, { method: 'POST', headers: { 'X-Setup-Key': f.config.adminToken } });
  assert.equal(collected.status, 409);
});
