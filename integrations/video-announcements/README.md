# Article-triggered video announcements

Separate service; the YouTube detector and editorial/publishing workflow are unchanged.
Polls the public Shopify Atom feed every 15 minutes and emits the Brevo custom event
`video_announcement_ready` separately for each eligible subscriber in a selected list.
It does not send email directly, generate articles, or publish Shopify content.

## Current release

Deploy with `ANNOUNCEMENTS_ENABLED=false`. The first successful feed read establishes
a durable baseline and never announces existing articles. Only new video IDs in articles
published after that baseline become pending. Edits and duplicate video references do
not requeue announcements. Feed entries without a valid episode link, title, publication
date or excerpt are held out. Only the Clip Breakdown blog is monitored.

The email uses the article's existing editorial summary (up to 120 words), stripped of
HTML/CSS and the RSS More link. There is no AI rewrite or new model credential required.
`teaser_2` is empty. The video title is currently the article title. The thumbnail uses
YouTube's original `hqdefault.jpg`, not a generated article illustration.

## Deployment

Use a dedicated Railway service named `video-announcements` from this repo branch.
Set root directory `/integrations/video-announcements`, Dockerfile `Dockerfile`, one replica,
cron `*/15 * * * *` and restart policy NEVER. Attach a persistent volume at `/data`.
The lock and SQLite database must survive restarts. Back up this volume. Never delete
or replace state casually: losing it resets the baseline and delivery history.

Variables:

- `ANNOUNCEMENTS_ENABLED=false` until Brevo workflow and audience are verified.
- `BREVO_API_KEY`: enter securely in the Railway Variables tab; never in Git/chat.
- `EXPECTED_BREVO_ORGANIZATION_ID`: immutable organization ID verified from the intended
  account's `/account` response. Required for setup and delivery; matching email alone
  is insufficient because separate accounts can use the same email. A replaced key must
  be checked against this ID. Setup registration history is scoped per organization.
- `BREVO_ANNOUNCEMENT_LIST_ID`: the ID of the confirmed opt-in list approved for video notifications.
- `ANNOUNCEMENT_STATE_DIR=/data` (optional; default).

The worker verifies that the API key belongs to `nick@nickdiramio.com` and checks each
contact's current list membership and email blacklist immediately before creating its
event. List membership must represent the intended marketing consent; the worker cannot
infer consent from an arbitrary list. Never point it at an all-contacts/import list.

## Brevo setup (not automated by this service)

To make the event and its fields appear in Brevo, temporarily set
`REGISTER_SETUP_EVENT=true` with `ANNOUNCEMENTS_ENABLED=false` and the Brevo workflow
inactive. The next run registers one `setup_only=true` event on an existing owner
contact (`nick@nickdiramio.com`, falling back to `nickdiramio@gmail.com`). It never
creates contacts, looks up the subscriber audience, or uses an email sending endpoint.
If neither owner address is a contact, setup fails with an explicit error. Success
is recorded in persistent state so later polls do not repeat it. On success remove
the setup flag. An uncertain attempt must be reconciled with Brevo before retrying.
Add an event filter **setup_only equals false** to the production workflow; real
announcements always carry `setup_only=false`.

1. Create an inactive workflow with Custom event `video_announcement_ready`.
2. Add the approved image-wordmark announcement HTML to its Send an email action.
3. Select **Event that triggered this automation** for event data, not Latest instance.
4. Match the subject and hidden preheader to the event fields. Allow re-entry after exit
   for future video announcements, and constrain the workflow to the approved list.
5. Inspect a manually supplied JSON preview in the editor; do not send to the whole list
   to test the layout. Verify event property mapping against an actual event before rollout.
6. Review pending announcement count. Activate the Brevo workflow only when ready,
   then set `ANNOUNCEMENTS_ENABLED=true`. Events accepted before workflow activation
   may not be replayed automatically.

All parameters are frozen for that announcement:
`video_title`, `youtube_url`, `thumbnail_url`, `article_url`, `teaser_1`, `teaser_2`,
`preview_text`, `video_id`, `announcement_id`.
The current Brevo Events API payload uses `event_properties`; the email uses `params.*`.
Validate mapping in Brevo's actual event preview before enabling production delivery.

## Delivery behavior and operational limits

Audience is snapshotted when a pending article is queued, excludes blacklisted contacts,
and then is rechecked per contact. Subscribers added later don't receive past uploads.
Delivery key is (video ID, contact ID). Each run handles up to 100 contact events, so
larger audiences drain over later polls. Each successful API event is `accepted`, not
proof of email delivery: inspect Brevo workflow/email logs for that.

Before POSTing an event, the delivery is durably marked `uncertain`. On success it becomes
`accepted`. A crash, rejection, or timeout leaves it `uncertain` and stops that run. These
rows are NEVER blindly retried: an operator must reconcile them with Brevo event logs
and explicitly requeue only confirmed non-acceptances. This favors avoiding duplicates
over automatic retries; it does not claim exactly-once external delivery.

The public feed currently contains 30 entries. More than 30 new articles between
successful polls could be missed; this is a low-volume channel integration, not an
archive crawler. No Shorts detection is inferred from video duration here: it depends
on the publishing workflow putting qualifying episodes in this blog. A `/shorts/` link
alone does not qualify. Logs contain counts and error types, not subscriber addresses,
keys or article text. `uncertain` counts or `announcement_poll_failed` require attention.

Pause by setting `ANNOUNCEMENTS_ENABLED=false`; pending items remain queued for later.
To discard stale pending items, inspect and explicitly mark them skipped in the state
database before resuming; do not delete the database or reset the baseline.

## Validation

```sh
cd integrations/video-announcements
python3 -m unittest -v
```

Tests use local temporary databases and mocked Brevo responses. No subscriber events or
email sends occur. Public feed parsing can be tested separately using saved Atom bytes.

API reference: https://developers.brevo.com/docs/event-endpoints
Automation: https://help.brevo.com/hc/en-us/articles/24257124386066
