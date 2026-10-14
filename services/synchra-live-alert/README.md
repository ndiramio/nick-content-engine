# Synchra live alert

Signed webhook receiver for nickdiramio.com, deployed as a Railway Bun Function in Nick Content Engine. The storefront integration is installed only in the unpublished **Nick DiRamio Theme 2026**, ID `183865901366`.

## Endpoints

- `POST /webhooks/synchra`: Standard Webhooks HMAC-SHA256 verification over the raw request body, five-minute timestamp tolerance, CloudEvent validation and durable duplicate suppression.
- `GET /status`: public minimal stream state with CORS for nickdiramio.com and www.nickdiramio.com. No signed payloads or secrets are returned.
- `GET /setup`: setup screen; management actions require the private management key.
- `/admin/config`, `/admin/status`, `/admin/clear`: authenticated configuration, latest signed-event inspection and manual banner clearing.
- `GET /health`: deployment health check.

The image is read from Synchra's documented `data.embed.image_url` field. `DEFAULT_IMAGE_URL` falls back to Nick's Shopify-hosted Control Issues emblem. The theme also has a configurable fallback image.

## Railway deployment

Deploy the entire `index.ts` as a Railway Function on Bun. Attach a volume at `/data`; keep one replica. Set `PORT=3000`, `DATA_DIR=/data`, a strong random `ADMIN_TOKEN`, and `DEFAULT_IMAGE_URL`. Generate an HTTPS domain. The signing secret can be set as `SYNCHRA_SIGNING_SECRET` or saved through the authenticated setup page into the durable SQLite database. Never commit real secrets.

Current webhook: https://synchra-live-alert-production.up.railway.app/webhooks/synchra

Current public status: https://synchra-live-alert-production.up.railway.app/status

Image: https://cdn.shopify.com/s/files/1/0871/3420/8310/files/control-issues-live-now.png?v=1791914729

Changes to this source in GitHub do not automatically update the Railway Function. Update it through Railway's function editor or MCP using the full source file, or migrate to a repository-backed Bun service.

## Synchra activation

Create a Generic webhook using the receiver URL. Add the Shopify image URL to the notification embed. Save the signing secret through `/setup` using the management key provided privately. Leave the live event type blank initially, then send a signed Synchra test notification. The private status view shows the exact event type and data shape. Set the live event type and URL/title field paths from that payload, save, and send another notification.

The Synchra documentation does not specify the complete stream object or live/offline event types. They are intentionally configurable rather than assumed. No banner is activated until the live type is mapped explicitly. If an offline event is supported, configure its exact type. Otherwise use Hide banner at stream end. A configurable four-hour safety expiry prevents an indefinitely stale alert; it is not live-status polling.

## Shopify integration

Add `section.liquid` as `sections/synchra-live-alert.liquid`. Add the translation keys in `translations.json` under `sections.synchra_live_alert` in the English locale. Add the section configuration in `header-section.json` to the header section group and prepend `synchra_live_alert` to its order. These changes are already applied to theme 183865901366 once the Shopify write succeeds; no theme publishing is part of this feature.

The banner polls every 30 seconds while visible, hides on errors or expiry, uses HTTPS links only and writes titles with `textContent`. It includes a clickable image, stream button, per-stream dismissal and a clearly labeled sample in the theme editor. Shopify CDN images are resized to 480 pixels for this compact layout.

Preview: https://nickdiramio.com/?preview_theme_id=183865901366

## Verification

Run `bun test index.test.ts`. Tests cover missing secrets, bad signatures, past/future delivery timestamps, body tampering, duplicate deliveries, old events, safety expiry, offline events, management authentication, CORS and image selection. Theme changes are validated using Shopify Theme Check and GraphQL operations are schema-validated before execution.

## Limits

The final Synchra handshake requires its real signing secret and a signed test event. A synthetic test fixture is not evidence of Synchra's real payload shape. YouTube Community posting is not implemented because YouTube exposes no public Community-post creation API.
