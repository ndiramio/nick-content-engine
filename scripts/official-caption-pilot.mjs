// Manual owner-authorized caption download. Does not run from the detector cron.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PILOT = [
  { videoId: 'LgWKZ3Zkmgw', durationSeconds: 3693 },
  { videoId: 'GcZ0PXabwt0', durationSeconds: 1918 },
  { videoId: '37CUChtKyAg', durationSeconds: 588 },
];
export class CaptionError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new CaptionError(code); };
function timestamp(value) {
  const parts = value.split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some(n => !Number.isFinite(n) || n < 0)) fail('INVALID_CAPTIONS');
  return parts.reduce((total, n) => total * 60 + n, 0);
}

export function parseVtt(text, durationSeconds) {
  if (!/^\uFEFF?WEBVTT(?:\s|$)/.test(text)) fail('INVALID_CAPTIONS');
  const segments = [];
  for (const block of text.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    if (/^(WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) continue;
    const timing = lines.findIndex(line => line.includes('-->'));
    if (timing === -1) continue;
    const match = lines[timing].match(/^((?:\d+:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}\.\d{3})(?:\s|$)/);
    if (!match) fail('INVALID_CAPTIONS');
    const start = timestamp(match[1]), end = timestamp(match[2]);
    const content = lines.slice(timing + 1).join('\n').replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
    if (end < start || end > durationSeconds + 15 || start < (segments.at(-1)?.start ?? 0)) fail('INVALID_CAPTIONS');
    if (content) segments.push({ start, duration: end - start, text: content });
  }
  if (!segments.length) fail('INVALID_CAPTIONS');
  return segments;
}

function save(path, content) {
  writeFileSync(`${path}.tmp`, content, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export async function runOfficialPilot({ config, outputDir, fetchImpl = fetch, emit = console.log }) {
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const request = async (url, options = {}) => {
    let response;
    try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(30_000) }); }
    catch { fail('NETWORK_ERROR'); }
    if (response.status === 401) fail('AUTH_REQUIRED');
    if (response.status === 403) fail('CAPTION_ACCESS_DENIED');
    if (response.status === 429) fail('RATE_LIMITED');
    if (!response.ok) fail('GOOGLE_REQUEST_FAILED');
    return response;
  };
  const json = async response => {
    try { return await response.json(); } catch { fail('INVALID_API_RESPONSE'); }
  };
  const outcomes = [];
  let headers;
  let authFailure;
  try {
    if (![config.clientId, config.clientSecret, config.refreshToken, config.channelId].every(Boolean)) fail('AUTH_REQUIRED');
    const token = await json(await request('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
        refresh_token: config.refreshToken, grant_type: 'refresh_token' }),
    }));
    if (!token.access_token) fail('AUTH_REQUIRED');
    headers = { Authorization: `Bearer ${token.access_token}` };
    const channel = await json(await request('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true', { headers }));
    if (!channel.items?.some(item => item.id === config.channelId)) fail('WRONG_CHANNEL');
  } catch (error) {
    authFailure = error instanceof CaptionError ? error.code : 'AUTH_REQUIRED';
  }

  for (const { videoId, durationSeconds } of PILOT) {
    const path = join(outputDir, `${videoId}.json`);
    let outcome;
    if (authFailure) outcome = { videoId, status: authFailure };
    else if (existsSync(path)) {
      const cached = JSON.parse(readFileSync(path, 'utf8'));
      if (cached.videoId !== videoId || cached.status !== 'RETRIEVED' || !cached.segments?.length) fail('INVALID_SAVED_TRANSCRIPT');
      outcome = { ...cached, cached: true };
      delete outcome.segments;
    } else {
      try {
        const tracks = await json(await request(`https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${videoId}`, { headers }));
        if (!Array.isArray(tracks.items)) fail('INVALID_API_RESPONSE');
        const track = tracks.items.filter(item => /^en(?:-|$)/i.test(item.snippet?.language)
          && item.snippet?.status === 'serving' && !item.snippet?.isDraft && item.snippet?.trackKind !== 'forced')
          .sort((a, b) => Number(a.snippet.trackKind === 'ASR') - Number(b.snippet.trackKind === 'ASR'))[0];
        if (!track) fail('NO_ENGLISH_CAPTIONS');
        const response = await request(`https://www.googleapis.com/youtube/v3/captions/${encodeURIComponent(track.id)}?tfmt=vtt`, { headers });
        const vtt = await response.text();
        const segments = parseVtt(vtt, durationSeconds);
        outcome = { videoId, status: 'RETRIEVED', provider: 'youtube-data-api-v3',
          sourceUrl: `https://www.youtube.com/watch?v=${videoId}`, captionTrackId: track.id,
          language: track.snippet.language, isGenerated: track.snippet.trackKind === 'ASR',
          retrievedAt: new Date().toISOString(), videoDurationSeconds: durationSeconds,
          segmentCount: segments.length, wordCount: segments.reduce((n, s) => n + s.text.split(/\s+/).length, 0),
          lastCaptionEndSeconds: Math.max(...segments.map(s => s.start + s.duration)),
          needsEditorialReview: true };
        save(join(outputDir, `${videoId}.vtt`), vtt);
        save(path, JSON.stringify({ ...outcome, segments }, null, 2) + '\n');
      } catch (error) {
        outcome = { videoId, status: error instanceof CaptionError ? error.code : 'CAPTION_FETCH_FAILED' };
        if (['AUTH_REQUIRED', 'RATE_LIMITED'].includes(outcome.status)) authFailure = outcome.status;
      }
    }
    outcomes.push(outcome);
  }
  const summary = { event: 'official_caption_pilot_completed', dryRun: true,
    checkedAt: new Date().toISOString(), videos: outcomes,
    retrieved: outcomes.filter(item => item.status === 'RETRIEVED').length };
  save(join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  emit(JSON.stringify(summary));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOfficialPilot({ config: { clientId: process.env.YOUTUBE_OAUTH_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_OAUTH_CLIENT_SECRET, refreshToken: process.env.YOUTUBE_OAUTH_REFRESH_TOKEN,
    channelId: process.env.YOUTUBE_CHANNEL_ID },
    outputDir: resolve(process.env.CAPTION_OUTPUT_DIR || 'data/official-caption-pilot'),
  }).then(summary => { process.exitCode = summary.retrieved === PILOT.length ? 0 : 2; }).catch(() => {
    console.error(JSON.stringify({ event: 'official_caption_pilot_failed', dryRun: true, reason: 'pilot_storage_or_configuration_error' }));
    process.exitCode = 1;
  });
}
