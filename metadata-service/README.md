# Video metadata service

A separate read-only Railway service for the unpublished Shopify Video Companion. It retrieves `videos.list` snippet metadata for public, embeddable videos belonging to `YOUTUBE_CHANNEL_ID`. It never writes to Shopify or runs the detector.

Run with Node 24 and `npm start`. Required server variables are `YOUTUBE_API_KEY` and `YOUTUBE_CHANNEL_ID`; `PORT` defaults to 3000. Reference the existing detector variables in Railway rather than copying secrets into the repository.

`GET /video-metadata?id=VIDEO_ID` returns `{videoId,title,publishedAt}`. Invalid IDs return 400, unavailable/other-channel videos 404, exhausted lookup budgets 429, and unavailable upstream metadata 502. `/health` reports configuration presence. Errors never return API keys or upstream bodies.

Successful metadata is cached for 24 hours, missing videos for ten minutes, and concurrent lookups coalesce. Each instance permits at most 120 uncached lookups per hour and ten concurrent upstream requests. Browser origins are limited to Nick's storefront domains. CORS is not an authentication boundary; the bounded global lookup budget also applies to clients without an Origin header. Cache is bounded and intentionally disposable across restarts. Run one replica.

Deploy this directory as a separate service with root directory `/metadata-service`, config file `/metadata-service/railway.json`, no cron schedule, and `/health` healthcheck. The root Railway configuration remains the hourly dry-run detector configuration.

The theme uses the source video date only in its visible date line; article publication structured metadata remains the article date. Failed lookups retain the article date. Displayed video calendar dates use UTC consistently across visitors.

Run `npm test` and `npm run lint` within this directory.
