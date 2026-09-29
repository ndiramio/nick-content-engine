# Nick Content Engine

Private automation for NickDiRamio.com.

Phase 1 is a **dry-run YouTube detector**. It reads recent uploads and classifies them but cannot write to Shopify.

Required Railway variables:
- `YOUTUBE_API_KEY`
- `YOUTUBE_CHANNEL_ID`

Decisions: `ARTICLE`, `IGNORE_SHORT`, `IGNORE_PROMO`, `NEEDS_REVIEW`.

After validation, later phases add duplicate tracking, transcript retrieval, editorial generation, and Shopify draft-only creation.
