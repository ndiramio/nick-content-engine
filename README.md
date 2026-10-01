# Nick Content Engine

Private automation for NickDiRamio.com. This phase is a **dry-run YouTube detector**.
It saves classification results, but does not retrieve transcripts, generate articles,
connect to Shopify, or publish anything. Dry-run is hardcoded; there is no publishing switch.

## Architecture and persistent state

`src/index.js` resolves the channel's uploads playlist, paginates through all uploads,
checks saved video IDs, and fetches details for unseen IDs in batches of up to 50.
The first run classifies the existing channel backlog. Later runs still scan every
playlist page so gaps, newly visible videos, and uploads after downtime are not missed.
API requests have a 30-second timeout. Failures exit nonzero and are retried on the next
scheduled run; already committed results remain saved.

`src/store.js` uses Node's built-in SQLite, with no third-party runtime dependencies.
A unique `video_id` primary key and atomic conflict-safe insert store each video's
classification exactly once, including `IGNORE_SHORT` and `NEEDS_REVIEW`. Duplicate
IDs are skipped before requesting details. WAL journaling and full synchronous commits
protect saved results across process failures. Separate connections cannot insert the
same ID twice. The process closes its database in a `finally` block.

**Railway requires an attached persistent volume.** Its normal deployment filesystem
is ephemeral. Mount a volume at `/data` on the detector service; the default database
will be `/data/detector.sqlite`. Preserve this volume across deployments/restarts and
configure Railway volume backups. Do not delete it when redeploying. Use one service
instance with this volume. A future multi-service design should use a shared database.
The app fails before calling YouTube if Railway has no volume, or the configured state
path is outside that volume. `railway.json` cannot provision the volume for you.

The database is the authoritative dry-run result. Results are committed before their
log entry is emitted. A crash between commit and log emission can omit a log entry,
but will not reprocess the video. Classification computation may repeat before a
successful commit. This is not a guarantee of exactly-once external side effects;
future publishing would require a separate transactional delivery design.

Saved videos are not reclassified when metadata or rules change. Unavailable videos
and live/upcoming broadcasts are deferred without marking them processed, allowing
later runs to use final metadata. Missing/invalid durations are saved for manual review.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | Yes | Existing YouTube Data API key, stored only in Railway variables or local environment |
| `YOUTUBE_CHANNEL_ID` | Yes | Channel whose uploads should be checked |
| `RAILWAY_VOLUME_MOUNT_PATH` | On Railway | Automatically supplied by Railway when the volume is attached; normally `/data` |
| `STATE_DB_PATH` | No | SQLite file path; defaults to `<volume>/detector.sqlite` on Railway or `./data/detector.sqlite` locally |

Do not manually fake the volume variable or point state at temporary storage. Keep API
keys out of source, logs, commands pasted into shared terminals, and commits. `.env*`
and database files are ignored by Git. The app does not automatically load `.env` files.
API failures log only sanitized status/errors, never API response bodies or request URLs.

## Classifier rules

| Duration / metadata | Classification |
| --- | --- |
| 3 minutes or shorter (0–180 seconds) | `IGNORE_SHORT` |
| Longer than 3 minutes, shorter than 8 (181–479 seconds) | `NEEDS_REVIEW` |
| 8 minutes or longer (480+ seconds) | `ARTICLE` |
| 8+ minutes with strong promo/teaser/trailer/preview metadata | `NEEDS_REVIEW` |
| Missing or invalid duration | `NEEDS_REVIEW` |

Strong metadata means an explicit format label: a standalone title/tag such as
`Official Trailer`, a title suffix such as `My show | Teaser`, a title prefix like
`Preview: next episode`, a format hashtag in the title, or an opening description
that identifies the video as a promo/teaser/trailer/preview. Ordinary incidental
mentions such as `promo code` or `trailer reaction` do not alone trigger the override.
This is a conservative heuristic, not semantic content analysis. Duration rules take
priority for videos under eight minutes. `IGNORE_PROMO` is no longer used.

## Railway scheduled detector

The repository's `railway.json` runs `npm start` at minute 0 of every hour (UTC), with
restart policy `NEVER`. Railway starts one execution on each scheduled tick. The
process makes one complete pass and exits; there is no HTTP server, listening port,
interval timer, or in-process scheduler. Railway skips a tick if the previous run
has not finished. Remove any old HTTP healthcheck setting from the service.

Deployment setup:

1. Keep the existing YouTube variables on the connected service.
2. Attach a persistent Railway volume to this service at `/data` before running it.
3. Deploy `main` and confirm Railway uses the repository's `railway.json`, Node 24,
   start command `npm start`, hourly cron, and restart policy `NEVER`.
4. Check logs for `run_completed` and verify a subsequent run reports duplicates
   with zero new processing when the channel has no new uploads.

Each log line is JSON with a timestamp and `dryRun: true`. Events include
`run_started`, `new_video`, `video_deferred`, `run_completed`, and `run_failed`.
A `new_video` includes `videoId`, `title`, ISO `duration`, `durationSeconds`,
`classification`, `reason`, and `processedAt`. Completion logs contain discovered,
processed, duplicate, and deferred counts. There are no new-video logs for duplicates.

Example (illustrative):

```json
{"timestamp":"2026-10-01T00:00:00.000Z","dryRun":true,"event":"new_video","videoId":"example-id","title":"Full commentary episode","duration":"PT12M","durationSeconds":720,"classification":"ARTICLE","reason":"duration_at_least_8_minutes","processedAt":"2026-10-01T00:00:00.000Z"}
```

Railway references: [cron jobs](https://docs.railway.com/cron-jobs),
[persistent volumes](https://docs.railway.com/volumes), and
[configuration as code](https://docs.railway.com/config-as-code/reference).

## Local development and validation

Use Node.js 24 (built-in `node:sqlite`; some Node versions print an experimental warning).
No dependency installation is necessary. Provide the two YouTube variables securely in
your environment, then run `npm start` for a single local detection pass. Local state
is in the ignored `data/` directory.

```sh
npm test
npm run lint
```

Tests use fixtures and temporary databases; no real API keys or network calls are
needed. They cover duration boundaries, promo metadata, invalid durations, duplicate
persistence in a fresh process, unique inserts from separate connections, pagination,
partial-run recovery, live/unavailable video deferral, safe errors, and Railway storage
guards. `lint` runs Node syntax checks; this project has no external lint framework.
