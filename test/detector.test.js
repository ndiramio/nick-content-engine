import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { classify, detect, seconds, youtube } from '../src/index.js';
import { openStore, statePath } from '../src/store.js';

const video = (duration = 'PT8M', title = 'A full commentary episode', extra = {}) => ({
  id: 'video-1', contentDetails: { duration }, snippet: { title, ...extra },
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nick-detector-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'state.sqlite');
}
function mockRequest(videos, calls = []) {
  return async (path, params) => {
    calls.push({ path, params });
    if (path === '/channels') return { items: [{ contentDetails: { relatedPlaylists: { uploads: 'uploads' } } }] };
    if (path === '/playlistItems') return { items: videos.map(v => ({ contentDetails: { videoId: v.id } })) };
    if (path === '/videos') return { items: videos.filter(v => params.id.split(',').includes(v.id)) };
    throw new Error('Unexpected request');
  };
}
const run = (store, request, emit = () => {}) => detect({ key: 'test-only', channelId: 'channel', store, request, emit });

for (const [duration, decision] of [
  ['PT0S', 'IGNORE_SHORT'], ['PT2M59S', 'IGNORE_SHORT'], ['PT3M', 'IGNORE_SHORT'],
  ['PT3M1S', 'NEEDS_REVIEW'], ['PT7M59S', 'NEEDS_REVIEW'],
  ['PT8M', 'ARTICLE'], ['PT8M1S', 'ARTICLE'], ['PT1H', 'ARTICLE'],
]) {
  test(`duration ${duration} is ${decision}`, () => assert.equal(classify(video(duration)).decision, decision));
}
test('short promos remain ignored and intermediate promos need review', () => {
  assert.equal(classify(video('PT3M', 'Official Trailer')).decision, 'IGNORE_SHORT');
  assert.equal(classify(video('PT5M', 'Official Trailer')).decision, 'NEEDS_REVIEW');
});
test('strong promo metadata from title, tags, and first description line', () => {
  for (const title of ['Official Trailer', 'My next show | Teaser', 'PREVIEW: next episode', 'Promo', 'New show #trailer']) {
    assert.equal(classify(video('PT12M', title)).reason, 'strong_promo_metadata', title);
  }
  for (const extra of [{ tags: ['official teaser'] }, { description: 'Watch the official preview for my show' }]) {
    assert.equal(classify(video('PT8M', 'My next show', extra)).decision, 'NEEDS_REVIEW');
  }
});
test('incidental promo or trailer mentions do not override long commentary', () => {
  for (const title of ['Trailer reaction and analysis', 'A review of the movie trailer', 'My new clip breakdown']) {
    assert.equal(classify(video('PT12M', title, { description: 'Use my promo code\nWatch the trailer below' })).decision, 'ARTICLE');
  }
});
test('generic promo tags alone do not override long commentary', () => {
  for (const tag of ['trailer', 'preview', 'promo', 'teaser', 'new trailer']) {
    assert.equal(classify(video('PT10M', 'A commentary episode', { tags: [tag] })).decision, 'ARTICLE');
  }
  for (const [duration, title, tags] of [
    ['PT1H1M33S', 'Comparing Not Cool and Hollidaysburg', ['trailer']],
    ['PT31M58S', 'Shane Dawson on The Chair', ['trailer']],
    ['PT9M48S', 'Catching Kelce Episode 2 - Clip Breakdown', ['reality show trailer', 'preview']],
  ]) assert.equal(classify(video(duration, title, { tags })).decision, 'ARTICLE');
  assert.equal(classify(video('PT10M', 'Official Trailer', { tags: ['trailer'] })).decision, 'NEEDS_REVIEW');
});

test('reviewed corrections are scoped, audited, and idempotent across restarts', t => {
  const path = fixture(t);
  let store = openStore(path);
  const row = (videoId, durationSeconds) => ({ videoId, title: 'Existing title', duration: 'PT10M',
    durationSeconds, classification: 'NEEDS_REVIEW', reason: 'strong_promo_metadata', processedAt: 'original-time' });
  for (const [id, duration] of [['LgWKZ3Zkmgw', 3693], ['GcZ0PXabwt0', 1918], ['37CUChtKyAg', 588], ['unreviewed', 600]]) {
    store.record(row(id, duration));
  }
  assert.equal(store.applyReviewedCorrections().length, 3);
  assert.deepEqual(store.classificationCounts(), { ARTICLE: 3, NEEDS_REVIEW: 1 });
  assert.deepEqual(store.applyReviewedCorrections(), []);
  store.close();
  store = openStore(path);
  assert.deepEqual(store.applyReviewedCorrections(), []);
  assert.equal(store.has('LgWKZ3Zkmgw'), true);
  store.close();
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM classification_corrections').get().n, 3);
    assert.equal(db.prepare('SELECT processed_at FROM processed_videos WHERE video_id = ?').get('LgWKZ3Zkmgw').processed_at, 'original-time');
  } finally { db.close(); }
});

test('review correction does not overwrite changed metadata or unrelated decisions', t => {
  const store = openStore(fixture(t));
  t.after(() => store.close());
  store.record({ videoId: 'LgWKZ3Zkmgw', title: 'Changed', duration: 'PT8M', durationSeconds: 480,
    classification: 'NEEDS_REVIEW', reason: 'strong_promo_metadata', processedAt: 'original-time' });
  store.record({ videoId: 'GcZ0PXabwt0', title: 'Changed', duration: 'PT31M58S', durationSeconds: 1918,
    classification: 'NEEDS_REVIEW', reason: 'manual_review', processedAt: 'original-time' });
  assert.deepEqual(store.applyReviewedCorrections(), []);
});
test('missing/malformed durations are reviewed and ISO day/hour values parse', () => {
  for (const duration of [undefined, '', 'junkPT3M', 'PT3Mgarbage', 'P', 'PT', '-PT1M']) {
    assert.equal(classify({ contentDetails: { duration } }).reason, 'missing_or_invalid_duration');
  }
  assert.equal(seconds('P1DT2H3M4S'), 93784);
});
test('duplicate IDs persist across a fresh Node process; details fetched only for new IDs', async t => {
  const path = fixture(t);
  const store = openStore(path);
  const logs = [];
  await run(store, mockRequest([video(), video()]), row => logs.push(row));
  store.close();
  assert.equal(logs.filter(row => row.event === 'new_video').length, 1);
  assert.deepEqual(Object.keys(logs.find(row => row.event === 'new_video')).sort(),
    ['event', 'videoId', 'title', 'duration', 'classification', 'durationSeconds', 'reason', 'processedAt'].sort());
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { openStore } from './src/store.js'; const store = openStore(process.argv[1]); if (!store.has('video-1')) process.exitCode = 1; store.close();`, path], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const reopened = openStore(path);
  try {
    const calls = [];
    const counts = await run(reopened, mockRequest([video()], calls));
    assert.equal(counts.processed, 0);
    assert.equal(counts.duplicates, 1);
    assert.equal(calls.some(call => call.path === '/videos'), false);
  } finally { reopened.close(); }
});
test('all classifications are tracked, including ignored shorts', async t => {
  const store = openStore(fixture(t));
  t.after(() => store.close());
  const videos = ['PT1M', 'PT5M', 'PT8M'].map((duration, i) => ({ ...video(duration), id: `id-${i}` }));
  assert.equal((await run(store, mockRequest(videos))).processed, 3);
  assert.equal((await run(store, mockRequest(videos))).duplicates, 3);
});
test('unique constraint arbitrates separate database connections', t => {
  const path = fixture(t);
  const first = openStore(path);
  const second = openStore(path);
  try {
    const row = { videoId: 'same', title: 'title', duration: 'PT8M', durationSeconds: 480,
      classification: 'ARTICLE', reason: 'duration_at_least_8_minutes', processedAt: 'test' };
    assert.equal(first.has('same'), false);
    assert.equal(second.has('same'), false);
    assert.equal(first.record(row), true);
    assert.equal(second.record(row), false);
  } finally { first.close(); second.close(); }
});
test('pagination continues past duplicates and recovers after partial API failure', async t => {
  const store = openStore(fixture(t));
  t.after(() => store.close());
  const base = mockRequest([video()]);
  let fail = true;
  const request = async (path, params) => {
    if (path === '/playlistItems') {
      if (!params.pageToken) return { items: [{ contentDetails: { videoId: 'video-1' } }], nextPageToken: 'page2' };
      if (fail) throw new Error('simulated API failure');
      return { items: [{ contentDetails: { videoId: 'video-2' } }] };
    }
    if (path === '/videos' && params.id === 'video-2') return { items: [{ ...video(), id: 'video-2' }] };
    return base(path, params);
  };
  await assert.rejects(run(store, request), /simulated/);
  assert.equal(store.has('video-1'), true);
  assert.equal(store.has('video-2'), false);
  fail = false;
  const counts = await run(store, request);
  assert.equal(counts.processed, 1);
  assert.equal(counts.duplicates, 1);
});
test('unavailable and live videos are retried later', async t => {
  const store = openStore(fixture(t));
  t.after(() => store.close());
  const request = mockRequest([video('PT0S', 'Live', { liveBroadcastContent: 'live' })]);
  assert.equal((await run(store, request)).deferred, 1);
  assert.equal(store.has('video-1'), false);
  const base = mockRequest([video()]);
  assert.equal((await run(store, (path, params) => path === '/videos' ? { items: [] } : base(path, params))).deferred, 1);
  assert.equal((await run(store, base)).processed, 1);
});
test('API errors exclude keys, URLs, response bodies and raw network errors', async () => {
  await assert.rejects(youtube('/videos', { key: 'secret' }, async () => ({ ok: false, status: 403, text: () => 'secret' })), { message: 'YouTube API HTTP 403' });
  await assert.rejects(youtube('/videos', { key: 'secret' }, async () => { throw new Error('URL secret'); }), { message: 'YouTube request failed or timed out' });
});
test('Railway requires persistent storage and rejects paths outside it', t => {
  assert.throws(() => statePath({ RAILWAY_SERVICE_ID: 'service' }), /persistent volume/);
  const path = fixture(t);
  const mount = join(path, '..');
  assert.equal(statePath({ RAILWAY_VOLUME_MOUNT_PATH: mount }), join(mount, 'detector.sqlite'));
  assert.throws(() => statePath({ RAILWAY_VOLUME_MOUNT_PATH: mount, STATE_DB_PATH: '/tmp/elsewhere.sqlite' }), /inside/);
});
test('CLI fails with structured logs and exits when configuration is missing', () => {
  const child = spawnSync(process.execPath, ['src/index.js'], { env: {}, encoding: 'utf8' });
  assert.equal(child.status, 1);
  const record = JSON.parse(child.stdout);
  assert.equal(record.event, 'run_failed');
  assert.equal(record.dryRun, true);
  assert.match(record.error, /YOUTUBE_API_KEY/);
});

test('storage failures abort without claiming successful processing', async () => {
  const logs = [];
  const store = { has: () => false, record: () => { throw new Error('disk full'); } };
  await assert.rejects(run(store, mockRequest([video()]), row => logs.push(row)), /disk full/);
  assert.equal(logs.some(row => ['new_video', 'run_completed'].includes(row.event)), false);
});

test('corrupt state fails instead of silently resetting duplicate history', t => {
  const path = fixture(t);
  writeFileSync(path, 'this is not a database');
  assert.throws(() => openStore(path), /not a database/);
});
