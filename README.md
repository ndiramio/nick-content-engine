# Nick Content Engine

Private automation for NickDiRamio.com. This phase is a **dry-run YouTube detector**.
The scheduled detector saves classification results. A separate, manually invoked
three-video caption pilot is available for evaluation. Neither path generates articles,
connects to Shopify, or publishes anything. Dry-run is hardcoded; there is no publishing switch.

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

Saved videos are not generally reclassified when metadata or rules change. The reviewed
2026-10-01 correction updates only `LgWKZ3Zkmgw`, `GcZ0PXabwt0`, and `37CUChtKyAg`
from the original promo-review decision to `ARTICLE`, conditional on their original
reason and duration still matching. The update and audit record in
`classification_corrections` commit together. It preserves the original processing
timestamp and duplicate history and is safe to run repeatedly. Startup logs include
`classification_corrected` events and a `saved_classifications` count snapshot.
Unavailable videos
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

Strong metadata means an explicit format label: a standalone title such as
`Official Trailer`, a title suffix such as `My show | Teaser`, a title prefix like
`Preview: next episode`, a format hashtag in the title, or an opening description
that identifies the video as a promo/teaser/trailer/preview. Ordinary incidental
mentions such as `promo code` or `trailer reaction` do not alone trigger the override.
Generic tags (`trailer`, `preview`, `promo`, `teaser`, or `new trailer`) alone are
insufficient: commentary videos may use them as topic tags. Standalone tags explicitly
qualified with `official` or `exclusive` still count as a strong signal.
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

## Manual transcript pilot

`scripts/transcript_pilot.py` attempts English captions for exactly the three reviewed
commentary videos above, sequentially. It is **not called by `npm start` or cron**.
Run it in an isolated Railway sandbox with Python 3.10+:

```sh
python3 -m venv /tmp/transcript-pilot-venv
/tmp/transcript-pilot-venv/bin/pip install -r scripts/requirements-pilot.txt
/tmp/transcript-pilot-venv/bin/python scripts/transcript_pilot.py --output-dir data/transcript-pilot
```

The optional dependency is `youtube-transcript-api==1.2.4`. It uses public, unofficial
YouTube endpoints and needs no API key, account cookies, or OAuth credentials. This
is an access/quality pilot, not yet a production transcript service. Cloud IPs may be
blocked. An access block stops further requests and is reported as `ACCESS_BLOCKED`;
remaining videos are `NOT_ATTEMPTED_AFTER_ACCESS_BLOCK`. There are no proxy/cookie
workarounds or automatic retries. Missing English tracks, disabled captions, unavailable
videos, invalid transcripts, and other fetch failures have separate statuses.

Successful outputs preserve timed segments, source video ID/URL, language, whether
captions were generated, provider version, retrieval time, and basic length metrics.
Every transcript still needs editorial review for accuracy, completeness, speaker
identity, and quoted movie/TV footage before it can support an article. Operational
logs include summaries, never transcript text. Existing successful files are reused.
`summary.json` records the pilot outcomes; exit code 0 means all three were retrieved,
2 means at least one was not, and 1 indicates a configuration/storage failure.

Pilot files stay outside Git and the detector database. Copy wanted results out of
the ephemeral sandbox before its idle timeout; they do not persist on the production
volume automatically. Only the classifier correction changes production state.
Run the offline pilot tests with `npm run test:pilot` (Python standard library only).

If public-caption access is blocked, the supported API alternative requires a separate
YouTube OAuth grant from an account allowed to edit the videos; the existing API key
cannot download captions. That authorization is not configured by this pilot.
References: [public-caption library](https://github.com/jdepoix/youtube-transcript-api),
[official caption downloads](https://developers.google.com/youtube/v3/docs/captions/download).

## Owner-authorized caption pilot

The public pilot encountered a cloud-IP block. `npm run pilot:captions` provides a
separate official YouTube Data API pilot for the same three videos. It is manual;
the hourly detector still only classifies metadata. No YouTube changes, Shopify
writes, or publishing are performed.

Required variables for this optional command:

| Variable | Purpose |
| --- | --- |
| `YOUTUBE_OAUTH_CLIENT_ID` | Google web OAuth client ID |
| `YOUTUBE_OAUTH_CLIENT_SECRET` | Google web OAuth client secret |
| `YOUTUBE_OAUTH_REFRESH_TOKEN` | Owner-authorized offline caption access |
| `YOUTUBE_CHANNEL_ID` | Expected channel, checked before caption requests |
| `CAPTION_OUTPUT_DIR` | Optional output directory; defaults to ignored `data/official-caption-pilot` |

Keep credentials in Railway variables or a private local environment, never Git or
logs. An ephemeral sandbox does not provide durable output storage: copy caption
artifacts out before shutting it down, or explicitly use persistent storage when
running outside a sandbox. Credentials must not be bundled with those artifacts.

Google requires the `youtube.force-ssl` scope and permission to edit the videos for
caption downloads. The pilot uses only channel/caption GET requests after refreshing
its access token. It prefers a serving standard English track, falls back to automatic
English captions, and preserves raw VTT plus timed JSON with provenance and an
editorial-review flag. Successful files are reused on subsequent runs. Structured
summary logs omit credentials and transcript text; missing tracks, denied access,
invalid captions, wrong channel, and rate limits have separate failure statuses.
Exit codes are 0 for three successes, 2 for incomplete retrieval, and 1 for a local
configuration/storage failure. Mock API and VTT tests run under `npm test`.

`scripts/oauth-setup-server.mjs` is an isolated, temporary authorization helper,
never the production cron entrypoint. Set `OAUTH_BASE_URL` to its HTTPS origin,
`YOUTUBE_CHANNEL_ID`, optional `PORT` (8080), and optional `OAUTH_SETUP_DIR`
(`/tmp/nce-oauth`). Register the exact `/oauth/callback` URL on the Google web client.
The helper writes a private `setup.json`; its phone sign-in link and administrative
token are separate. Upload the Google client JSON via authenticated `POST /configure`,
complete the Google sign-in, then collect credentials through authenticated
`POST /collect` using the `X-Setup-Key` administrative header. It validates single-use
state, PKCE, granted scope, and channel identity. Sessions expire after 30 minutes;
authorization callbacks expire after 10 minutes. Shut down the helper after setup.
Never share the administrative token or publish its setup directory.

The Google app is currently External/Testing with the owner as a test user. Google
expires refresh tokens issued in this mode after seven days for this scope, so this
is sufficient for the pilot but needs a production OAuth configuration before a
long-running caption workflow. See [Google token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration)
and [web authorization](https://developers.google.com/identity/protocols/oauth2/web-server).

The initial official pilot retrieved all three tracks; the summary and sample-quality
notes are in `reports/official-caption-pilot-2026-10-01.json`. Two tracks contain rolling
repeated lines. Word counts are raw cue counts, not deduplicated spoken-word counts.
A standard track is not proof of human authorship; `isGenerated` reflects only the
API ASR flag. Caption cleanup and full editorial review remain future work.
