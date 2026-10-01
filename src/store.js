import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CORRECTION = '2026-10-01-generic-promo-tags';
// Individually reviewed against public titles/descriptions on 2026-10-01.
const REVIEWED_VIDEOS = [
  ['LgWKZ3Zkmgw', 3693],
  ['GcZ0PXabwt0', 1918],
  ['37CUChtKyAg', 588],
];

function applyReviewedCorrections(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const changed = [];
    const update = db.prepare(`UPDATE processed_videos
      SET classification = 'ARTICLE', reason = 'duration_at_least_8_minutes'
      WHERE video_id = ? AND duration_seconds = ?
        AND classification = 'NEEDS_REVIEW' AND reason = 'strong_promo_metadata'
        AND NOT EXISTS (SELECT 1 FROM classification_corrections
          WHERE correction_id = ? AND video_id = ?)`);
    const audit = db.prepare(`INSERT INTO classification_corrections
      (correction_id, video_id, previous_classification, previous_reason,
       classification, reason, corrected_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const [videoId, duration] of REVIEWED_VIDEOS) {
      if (!update.run(videoId, duration, CORRECTION, videoId).changes) continue;
      const correction = {
        correctionId: CORRECTION, videoId, previousClassification: 'NEEDS_REVIEW',
        previousReason: 'strong_promo_metadata', classification: 'ARTICLE',
        reason: 'duration_at_least_8_minutes', correctedAt: new Date().toISOString(),
      };
      audit.run(CORRECTION, videoId, correction.previousClassification,
        correction.previousReason, correction.classification, correction.reason, correction.correctedAt);
      changed.push(correction);
    }
    db.exec('COMMIT');
    return changed;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function statePath(env = process.env) {
  const mount = env.RAILWAY_VOLUME_MOUNT_PATH;
  const railway = env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_SERVICE_ID || env.RAILWAY_PROJECT_ID;
  if (railway && !mount) {
    throw new Error('Railway requires an attached persistent volume; mount it at /data');
  }
  if (mount && !isAbsolute(mount)) throw new Error('Volume mount path must be absolute');
  const path = resolve(env.STATE_DB_PATH || join(mount || './data', 'detector.sqlite'));
  if (mount) {
    const inside = relative(resolve(mount), path);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
      throw new Error('STATE_DB_PATH must be inside the Railway volume');
    }
    // The mount must already exist, and symlinks must not redirect state outside it.
    const realMount = realpathSync(mount);
    mkdirSync(dirname(path), { recursive: true });
    const realParent = relative(realMount, realpathSync(dirname(path)));
    if (realParent.startsWith('..') || isAbsolute(realParent)) {
      throw new Error('State directory resolves outside the Railway volume');
    }
    if (existsSync(path)) {
      const realFile = relative(realMount, realpathSync(path));
      if (realFile.startsWith('..') || isAbsolute(realFile)) {
        throw new Error('State file resolves outside the Railway volume');
      }
    }
  }
  return path;
}

export function openStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS processed_videos (
        video_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        duration TEXT,
        duration_seconds INTEGER,
        classification TEXT NOT NULL,
        reason TEXT NOT NULL,
        processed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS classification_corrections (
        correction_id TEXT NOT NULL,
        video_id TEXT NOT NULL,
        previous_classification TEXT NOT NULL,
        previous_reason TEXT NOT NULL,
        classification TEXT NOT NULL,
        reason TEXT NOT NULL,
        corrected_at TEXT NOT NULL,
        PRIMARY KEY (correction_id, video_id)
      );
    `);
    const has = db.prepare('SELECT 1 FROM processed_videos WHERE video_id = ?');
    const insert = db.prepare(`INSERT INTO processed_videos
      (video_id, title, duration, duration_seconds, classification, reason, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(video_id) DO NOTHING`);
    return {
      applyReviewedCorrections: () => applyReviewedCorrections(db),
      classificationCounts: () => Object.fromEntries(db.prepare(
        'SELECT classification, COUNT(*) AS count FROM processed_videos GROUP BY classification'
      ).all().map(row => [row.classification, row.count])),
      has: id => Boolean(has.get(id)),
      record: row => insert.run(row.videoId, row.title, row.duration,
        row.durationSeconds, row.classification, row.reason, row.processedAt).changes === 1,
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
