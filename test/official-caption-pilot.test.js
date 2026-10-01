import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseVtt, runOfficialPilot, PILOT } from '../scripts/official-caption-pilot.mjs';

const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello &amp; welcome.\n\n1\n00:00:02.000 --> 00:00:05.000\n<v Nick>Let us begin.</v>\n';
const config = { clientId: 'test-client', clientSecret: 'test-secret', refreshToken: 'test-refresh', channelId: 'owner' };
const temp = t => { const path = mkdtempSync(join(tmpdir(), 'caption-pilot-')); t.after(() => rmSync(path, { recursive: true })); return path; };
function mock(calls, channel = 'owner') {
  return async (url, options) => {
    calls.push({ url, options });
    let data;
    if (url.includes('/token')) data = { access_token: 'test-access' };
    else if (url.includes('/channels')) data = { items: [{ id: channel }] };
    else if (url.includes('captions?')) data = { items: [
      { id: 'auto', snippet: { language: 'en', status: 'serving', trackKind: 'ASR' } },
      { id: 'manual', snippet: { language: 'en', status: 'serving', trackKind: 'standard' } },
    ] };
    return { ok: true, status: 200, json: async () => data, text: async () => vtt };
  };
}
test('VTT parsing preserves times and rejects empty or invalid captions', () => {
  assert.deepEqual(parseVtt(vtt, 10), [{ start: 0, duration: 2, text: 'Hello & welcome.' }, { start: 2, duration: 3, text: 'Let us begin.' }]);
  for (const text of ['WEBVTT\n', 'not captions', 'WEBVTT\n\n00:00:03.000 --> 00:00:02.000\nBad']) {
    assert.throws(() => parseVtt(text, 10), /INVALID_CAPTIONS/);
  }
});
test('official pilot reads only three videos, prefers manual captions, and caches results', async t => {
  const outputDir = temp(t), calls = [], logs = [];
  const result = await runOfficialPilot({ config, outputDir, fetchImpl: mock(calls), emit: line => logs.push(line) });
  assert.equal(result.retrieved, 3);
  assert.equal(calls.filter(c => c.url.includes('/captions/manual?')).length, 3);
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
  const saved = JSON.parse(readFileSync(join(outputDir, PILOT[0].videoId + '.json')));
  assert.equal(saved.segments.length, 2);
  assert.equal(saved.isGenerated, false);
  assert.equal(saved.needsEditorialReview, true);
  assert.equal(logs[0].includes('test-secret'), false);
  assert.equal(logs[0].includes('Hello & welcome'), false);
  const rerun = [];
  await runOfficialPilot({ config, outputDir, fetchImpl: mock(rerun), emit: () => {} });
  assert.equal(rerun.some(c => c.url.includes('/captions')), false);
});
test('official pilot rejects a different channel before requesting captions', async t => {
  const calls = [];
  const result = await runOfficialPilot({ config, outputDir: temp(t), fetchImpl: mock(calls, 'other'), emit: () => {} });
  assert.equal(result.retrieved, 0);
  assert.ok(result.videos.every(v => v.status === 'WRONG_CHANNEL'));
  assert.equal(calls.some(c => c.url.includes('/captions')), false);
});
test('missing credentials do not initiate a request', async t => {
  const result = await runOfficialPilot({ config: {}, outputDir: temp(t), fetchImpl: () => assert.fail(), emit: () => {} });
  assert.ok(result.videos.every(v => v.status === 'AUTH_REQUIRED'));
});
