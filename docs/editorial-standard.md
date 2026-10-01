# Editorial and search standard

Reviewed against Google Search Central guidance on 2026-10-01. This is Nick Content Engine’s editorial policy, not a Google certification, ranking guarantee, or automated quality score. It applies to manually prepared articles. The cron detector still only classifies video metadata; `ARTICLE` means a candidate, not publication approval.

## Purpose and voice

Help readers understand a movie, show, or media phenomenon through Nick’s specific observations and criticism. Search is a way for those readers to discover the work. Preserve the conversational voice approved in the first sample. Build a coherent argument with concrete examples and useful context; readers should benefit without having to watch the whole video. A faithful written adaptation can serve readers without inventing new reporting.

Google emphasizes original analysis, reliable sourcing, accurate authorship, and content that satisfies readers. It does not prescribe a preferred word count. Use enough space to answer the question and remove filler. Explain who created the work and distinguish historical commentary from current information. [Helpful content guidance](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)

## Brief before drafting

Record the intended reader, their question, a proposed search phrase, the article’s scope, and the value Nick’s observations add. Keyword ideas are hypotheses until supported by research or Search Console data. Never invent search volume, difficulty, or expected traffic. Check existing articles for overlapping coverage before assigning another page to the same question. These are our planning practices, not Google-mandated fields.

For each source, retain video ID, URL, actual upload date, caption provenance, and timestamps. Read the relevant content before adopting a thesis. A video description or chapter list can suggest a brief but cannot substantiate the completed article. Keep draft briefs marked provisional until sources are reviewed.

## Evidence and editorial review

Our editorial process requires:

- Preserve raw captions and an audit of cleanup. Confirm proper names and consequential quotations against audio or reliable primary sources.
- Separate Nick’s commentary, fictional dialogue, interview clips, satire, and advertisements. Uncertain attribution remains unresolved rather than guessed.
- Map each substantive claim to a source passage. Identify opinion as opinion. Do not turn an interpretation into an allegation or add unsupported motives.
- Keep dates accurate. An upload date is not the show’s release date or the article’s publication date. Recheck time-sensitive claims before using them.
- Remove obsolete promotions, unrelated tangents, and sponsor segments from the adaptation unless relevant to the article itself. Do not fabricate personal experience or new opinions for Nick.
- Have Nick review the article and proposed first-person wording. Record approval only for the exact revision reviewed. Approval of style alone is not factual verification or permission to publish.

## Titles and page metadata

Use a descriptive SEO title and a clear visible headline that promise the same content. Lead naturally with the identifiable subject; include a film year or episode when it resolves ambiguity. Copy the YouTube title only when it suits the article. Otherwise adapt it without changing the claim. Google can generate a different search title from headings and other signals. There is no mandatory 60-character cutoff; concise wording reduces truncation risk. [Title guidance](https://developers.google.com/search/docs/appearance/title-link)

Write a unique meta description after the draft, summarizing its actual argument. Avoid keyword lists and promises the page cannot fulfill. Google may use different page text instead, and its snippet length varies. A 150–160-character target is an optional editing convenience, not a Google requirement. [Snippet guidance](https://developers.google.com/search/docs/appearance/snippet)

Keep proposed slugs short and descriptive. Do not change published URLs casually. Add contextual links only to relevant existing pages; related private drafts are link candidates, not live URLs. Use informative headings and natural vocabulary instead of keyword-density targets. [SEO starter guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide)

## AI assistance and transparency

AI can help organize captions and prepare prose; accuracy, relevance, and useful original contribution still need review. Check generated metadata as carefully as the body. Google advises providing appropriate context about automation. Our default proposed disclosure is: “Adapted from Nick DiRamio’s original video commentary with AI-assisted transcription cleanup and drafting.” Add “Reviewed and edited by Nick DiRamio” only after that has actually happened. Use an accurate byline and a real author/about link when available. [Google’s generative AI guidance](https://developers.google.com/search/docs/fundamentals/using-gen-ai-content)

Do not automatically turn the backlog into hundreds of lightly rewritten pages. Reject, combine, or defer weak candidates. Google’s scaled-content-abuse policy concerns large amounts of content primarily made to manipulate rankings without helping users, regardless of the production method. Repeated keyword variants are not separate editorial assignments. [Spam policies](https://developers.google.com/search/docs/essentials/spam-policies#scaled-content)

## Review record

Use `article-brief-template.json`. Status progresses manually from `BRIEF` to `DRAFT` to `EDITORIAL_REVIEW`; `APPROVED_DRAFT` requires a named reviewer, date, and revision identifier. Unresolved source or authorship issues keep a draft in review. No numeric score overrides those issues. This record is documentation, not a runtime validator or publishing feature.

A completed package includes the brief, article, source notes, proposed metadata, relevant link candidates, and an honest review record. Neither age nor word count makes an article ready by itself.

## Before a future launch

Check the rendered page, mobile readability, working links, accessibility, crawlability, and intended indexing. Keep private drafts private; they have not become indexed pages by being saved locally. Confirm real author and publication information and any applicable structured data against visible content. Do not claim rich-result eligibility from a Markdown draft. Technical launch checks and publishing require separate implementation; no Shopify integration is authorized by this document.

After an authorized launch, review Search Console impressions, queries, clicks, and indexing alongside reader engagement. Improve the actual answer when evidence suggests a gap. Do not change dates merely to appear fresh or promise a ranking outcome. Review this standard when relevant guidance or the publishing system changes.
