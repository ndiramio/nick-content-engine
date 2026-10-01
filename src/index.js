import { pathToFileURL } from 'node:url';
import { openStore, statePath } from './store.js';

const API = 'https://www.googleapis.com/youtube/v3';

export function seconds(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match || !match.slice(1).some(v => v !== undefined)) return null;
  const total = (+match[1] || 0) * 86400 + (+match[2] || 0) * 3600
    + (+match[3] || 0) * 60 + (+match[4] || 0);
  return Number.isSafeInteger(total) ? total : null;
}

export function classify(video) {
  const duration = seconds(video.contentDetails?.duration);
  const result = (decision, reason) => ({ decision, seconds: duration, reason });
  if (duration === null) return result('NEEDS_REVIEW', 'missing_or_invalid_duration');
  if (duration <= 180) return result('IGNORE_SHORT', 'duration_at_most_3_minutes');
  if (duration < 480) return result('NEEDS_REVIEW', 'duration_between_3_and_8_minutes');

  // Deliberately require explicit format labels, not incidental mentions such as
  // "promo code", "trailer reaction", or a review discussing a movie trailer.
  const { title = '', description = '', tags = [] } = video.snippet || {};
  const label = '(?:promo|teaser|trailer|preview)';
  const standalone = new RegExp(`^(?:(?:official|exclusive|new)\\s+)?${label}(?:\\s+\\d+)?[.!]?$`, 'i');
  const explicit = new RegExp(`\\b(?:official|exclusive)\\s+${label}\\b|\\b${label}\\s+for\\b|#(?:promo|teaser|trailer|preview)\\b`, 'i');
  const suffix = new RegExp(`(?:\\s[-–—|:]\\s*|\\[|\\()(?:(?:official|exclusive|new)\\s+)?${label}(?:\\s+\\d+)?[\\])!.]*$`, 'i');
  const lead = new RegExp(`^(?:(?:official|exclusive|new)\\s+)?${label}\\s*[:|–—-]`, 'i');
  const selfDescription = new RegExp(`^(?:this (?:video )?is |watch |here(?:'s| is) )?(?:the |an? |our )?(?:(?:official|exclusive|new)\\s+)?${label}\\b(?!\\s+(?:code|codes|review|reaction|analysis|breakdown)\\b)`, 'i');
  const firstLine = description.trim().split(/\r?\n/)[0];
  if (standalone.test(title.trim()) || explicit.test(title) || suffix.test(title.trim())
      || lead.test(title.trim()) || selfDescription.test(firstLine)
      || tags.some(tag => standalone.test(tag.trim()))) {
    return result('NEEDS_REVIEW', 'strong_promo_metadata');
  }
  return result('ARTICLE', 'duration_at_least_8_minutes');
}

export function log(record) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), dryRun: true, ...record }));
}

export async function youtube(path, params, fetchImpl = fetch) {
  const url = new URL(API + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  } catch {
    // Never log URLs, response bodies, or raw fetch errors: they may contain keys.
    throw new Error('YouTube request failed or timed out');
  }
  if (!response.ok) throw new Error(`YouTube API HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error('YouTube API returned invalid JSON');
  }
}

export async function detect({ key, channelId, store, request = youtube, emit = log }) {
  const counts = { discovered: 0, processed: 0, duplicates: 0, deferred: 0 };
  emit({ event: 'run_started', channelId });
  const channel = await request('/channels', { part: 'contentDetails', id: channelId, key });
  const uploads = channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error('Could not resolve uploads playlist');
  let pageToken;
  const seen = new Set();
  const pageTokens = new Set();
  do {
    const page = await request('/playlistItems', {
      part: 'contentDetails', playlistId: uploads, maxResults: '50', key,
      ...(pageToken ? { pageToken } : {}),
    });
    if (!Array.isArray(page.items)) throw new Error('Invalid uploads playlist response');
    const ids = [];
    for (const item of page.items) {
      const id = item.contentDetails?.videoId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      counts.discovered++;
      if (store.has(id)) counts.duplicates++;
      else ids.push(id);
    }
    if (ids.length) {
      const details = await request('/videos', {
        part: 'snippet,contentDetails,status', id: ids.join(','), key,
      });
      if (!Array.isArray(details.items)) throw new Error('Invalid video details response');
      const byId = new Map(details.items.map(video => [video.id, video]));
      for (const id of ids) {
        const video = byId.get(id);
        // Live/upcoming and unavailable items may acquire final metadata later.
        if (!video || (video.snippet?.liveBroadcastContent && video.snippet.liveBroadcastContent !== 'none')) {
          counts.deferred++;
          emit({ event: 'video_deferred', videoId: id, reason: 'unavailable_or_live' });
          continue;
        }
        const classification = classify(video);
        const record = {
          videoId: id, title: video.snippet?.title || '',
          duration: video.contentDetails?.duration ?? null,
          classification: classification.decision, durationSeconds: classification.seconds,
          reason: classification.reason, processedAt: new Date().toISOString(),
        };
        // Commit the result before logging. The primary key arbitrates concurrent runs.
        if (store.record(record)) {
          counts.processed++;
          emit({ event: 'new_video', ...record });
        } else counts.duplicates++;
      }
    }
    pageToken = page.nextPageToken;
    if (pageToken && pageTokens.has(pageToken)) throw new Error('Repeated uploads page token');
    if (pageToken) pageTokens.add(pageToken);
  } while (pageToken);
  emit({ event: 'run_completed', ...counts });
  return counts;
}

export async function main(env = process.env) {
  for (const name of ['YOUTUBE_API_KEY', 'YOUTUBE_CHANNEL_ID']) {
    if (!env[name]?.trim()) throw new Error(`Missing required environment variable: ${name}`);
  }
  const store = openStore(statePath(env));
  try {
    return await detect({ key: env.YOUTUBE_API_KEY, channelId: env.YOUTUBE_CHANNEL_ID, store });
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    log({ event: 'run_failed', error: error.message });
    process.exitCode = 1;
  });
}
