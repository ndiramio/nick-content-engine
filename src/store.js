import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
    `);
    const has = db.prepare('SELECT 1 FROM processed_videos WHERE video_id = ?');
    const insert = db.prepare(`INSERT INTO processed_videos
      (video_id, title, duration, duration_seconds, classification, reason, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(video_id) DO NOTHING`);
    return {
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
