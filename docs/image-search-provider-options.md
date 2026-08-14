# Image-search provider options for unattended bottle discovery

Date: 2026-08-13

## Recommendation

Use **Brave Image Search and Serper Google Images as a bounded combined provider**. Serper currently offers 2,500 signup queries without a credit card, which is enough to run an exact and yearless Google pass across FineVines' 482-image backlog. Do not route CI through residential proxies or scrape Google directly.

This combination supplies two genuinely different indexes:

1. Brave returns results from its own independent image index.
2. Serper returns structured Google Images results, including the original image URL, indexed dimensions, and source page.

The 2026-08-14 frozen comparison queried 30 difficult wines. Both providers
remained healthy; four visually verified winners came from Serper. A fifth
automatic acceptance from Brave exposed a separate producer-proof defect and
was rejected during human audit. That trace is now a regression test: matching
appellation/cuvee text cannot anchor a bottle when the requested producer is
absent.

## FineVines evidence from the current production ledger

The Google Cloud Vision Web Detection rescue was enabled in CI; it was not a
missing-secret problem. In the earlier `origin/master` funnel ledger,
334 records invoked it (343 requests). Only nine records obtained any
downloadable expansion image, for 37 downloaded images total. Three of those
nine records are now resolved, but the durable ledger does not prove that Web
Detection caused those later resolutions. The 2026-08-14 frozen run then made
46 Web Detection requests, returned 230 candidates, downloaded 206 of them,
and recovered zero wines. Scheduled workflows now leave the optional adapter
disabled until another frozen replay demonstrates incremental value.

The dominant opportunity is earlier: supply the selector with candidates from
two genuinely different text-to-image indexes. Brave and Serper now run
concurrently, and their permitted results are interleaved into one bounded
15-candidate window so neither provider can crowd out the other.

## Recommended autonomous cascade

1. Query Brave and Serper once with the full catalog string, including vintage.
2. Keep provider result sets distinct in diagnostics, interleave them fairly,
   and deduplicate the permitted downloads by canonical URL before selection.
3. Run the selector on the combined evidence. Independent hosts displaying
   the same bottle strengthen consensus; provider agreement alone does not.
4. If unresolved, repeat the two-provider sequence without the vintage. A
   visible conflicting vintage remains a veto; an image with no visible year
   may still qualify under the existing identity rules.
5. Send only the unresolved tail to the protected human review page.

Every provider call must end in one of four durable states: `ok`, `empty`,
`unavailable`, or `misconfigured`. Cache only an `ok` result as search evidence;
never convert an outage, authentication error, or permission error into a
long-lived wine miss.

## Provider comparison

| Provider | Candidate contract | Limits and current price | Longevity and unattended-use fit | FineVines role |
|---|---|---|---|---|
| **Brave Image Search** | Each result pairs the source page with `properties.url`, the original image URL; Brave also supplies a proxied 500-pixel thumbnail and usually indexed dimensions. | Up to 200 images per request; current Search plan is $5 per 1,000 requests with $5 monthly credit and 50 queries/second. | First-party API backed by Brave's independent index and explicitly offered for applications and agents. | **Primary discovery provider.** Cheap, direct, legitimate, and already integrated. Keep its independent results even after adding Google coverage. |
| **Serper Google Images** | `images` results include `imageUrl`, indexed width/height, thumbnail, source/domain, source-page `link`, and a Google result URL. | 2,500 signup queries free with no credit card. The first paid top-up is $50 for 50,000 six-month credits, so the free allotment should be used for the backlog and provider evaluation rather than assuming a future free allowance. | Commercial real-time Google SERP API. It has the correct text-to-image contract but no documented Lens/reverse-image endpoint. | **Recommended zero-upfront secondary.** The free allotment covers exact plus yearless searches for the current 482-wine backlog. Keep Cloud Vision as the reverse-image service. |
| **SerpApi Google Images + Lens** | Image results include full-resolution URL, source page, dimensions, and source. Its Lens API returns visual matches and exact matches with direct images and source pages. | Free 250/month; $25 for 1,000/month, $75 for 5,000, $150 for 15,000. Only successful searches count. | Mature commercial SERP service. Paid plans advertise a limited U.S. Legal Shield, but that does not cover downstream copyright/DMCA use and does not make the service Google-approved. | **Best no-deposit single-vendor alternative.** The free tier is enough for a 30-wine test; the $25 plan can cover roughly one exact and one yearless pass across 482 wines, leaving little room for Lens calls. |
| **SearchApi Google Images + Lens** | Both APIs return direct images, dimensions, and source-page links; Lens supports explicit visual- and exact-match modes. | 100 requests free without a card; Developer is $40/month for 10,000 searches. | Commercial real-time SERP service with documented legal-collection coverage on paid plans. | **Higher-capacity no-deposit alternative.** More room than SerpApi but unnecessary before the free Serper test proves Google coverage. |
| **DataForSEO Google Images + Search By Image** | Advanced results expose hosting page, source image, cached image, title/alt, and a checkable SERP URL. | $0.0006-$0.002 per result page, but requires a $50 minimum deposit. | Strong technical contract, but rejected for FineVines because of the upfront deposit. | **Do not use under the current budget constraint.** |
| **Google Custom Search JSON API** | `searchType=image` returns the image `link`, source page `image.contextLink`, indexed dimensions, MIME information, and thumbnail. Results are not the same corpus or ranking as browser Google Images. | 100 queries/day free; $5 per 1,000; maximum 10,000/day. Ten results per request and no more than 100 for a query. | Closed to new customers and scheduled to discontinue on **2027-01-01**. | **Temporary third source only.** Continue using the existing key while useful, but do not build new dependence on it. |
| **Microsoft Bing Image Search API** | Formerly exposed image candidates. | No current product: all Bing Search APIs were retired on 2025-08-11. | Microsoft's replacement, Grounding with Bing Search, produces grounded model responses and citations rather than a raw image-candidate feed. | **Reject.** It cannot replace bottle-image discovery. |
| **Google Vertex AI Search / Agent Search** | Its image-search response can contain image links, context pages, dimensions, MIME, and thumbnails. | Website search is $4 per 1,000 queries; advanced indexing starts at $5/GB/month. | Searches a configured website-data application/corpus rather than the open web. Advanced site search requires domain verification. | **Not a broad-web replacement.** It could search a curated supplier/importer corpus, not discover arbitrary bottle images across the web. |
| **Gemini image grounding with Google Search** | Uses Google Image Search as context for image generation and returns citations/search-suggestion presentation data. It does not expose a downloadable candidate list for a catalog pipeline. | Model-specific Gemini billing applies. | Supported only for the documented image-generation grounding workflow. | **Reject for discovery.** Wrong output contract. |

## Useful follow-up once one credible image exists

Google Cloud Vision **Web Detection** accepts an image rather than a text query. It can return full matches, partial matches, visually similar image URLs, and pages containing those images. The first 1,000 feature requests each month are free; Web Detection is $3.50 per 1,000 thereafter.

That makes it a sensible later-stage *seed expansion* tool: take one high-confidence bottle image, find other copies, and use those copies to strengthen identity consensus or locate a cleaner source. It cannot replace the initial text-to-image search because it requires an input image.

The Cloud Vision adapter now submits both the whole bottle and label crop,
retains top-level exact matches as provisional when no source page can be
paired, and keeps merely similar images untrusted. The zero-yield frozen test
shows that this corrected adapter still does not justify scheduled spend.

## Why this is preferable to a proxy

A residential proxy would try to make CI automation look like a human browser session. It would not create a supported API contract, stable response schema, source/image pairing, or durable service guarantee. Google also prohibits hiding or misrepresenting identity to violate its terms and restricts automated access that violates machine-readable instructions.

The commercial SERP options are still vendor-contract and compliance choices, not Google licenses. Their advantage is operational: they sell an explicit unattended API, absorb browser/SERP rendering changes, return structured candidates, and provide billing and failure semantics. FineVines must continue to apply its existing source-policy, identity, watermark, download, and publication-quality gates to every result.

## Thirty-wine decision test

Use a fixed input set containing known Brave successes, Brave empty results, downloadable failures, and easy browser-Google examples such as TOR.

For each provider and wine, record:

- exact query and location/language parameters;
- HTTP status, provider status, latency, and billable cost;
- raw result count;
- source-page URL and direct-image URL for every candidate;
- source-policy decision;
- download status, final URL, content type, signature, and dimensions;
- identity, visual-consensus, watermark, and publication-quality result;
- accepted image, if any.

Decide using these metrics:

1. additional accepted wines beyond Brave;
2. accepted wines per paid request;
3. percentage of results with a valid image/source pairing;
4. download success from permitted hosts;
5. false-accept rate after human audit;
6. diagnostic completeness for every miss.

If Serper materially recovers the easy browser-Google misses, the production order should be:

1. Brave exact full-string query;
2. Serper Google Images exact full-string query only when Brave yields no accepted candidate;
3. yearless fallback only for the still-unresolved cohort;
4. Cloud Vision Web Detection only when a credible seed exists and more copies are useful;
5. protected human review for the remainder.

Do not merge provider results before logging them independently. Search failure, download failure, and identity rejection must remain visibly different outcomes.

## Primary sources

- Brave: [Image Search API documentation](https://api-dashboard.search.brave.com/documentation/services/image-search), [API reference](https://api-dashboard.search.brave.com/api-reference/images/image_search), and [current pricing](https://brave.com/search/api/).
- Serper: [Google Search API and pricing](https://serper.dev/).
- SearchApi: [Google Images API](https://www.searchapi.io/google-images), [Google Lens API](https://www.searchapi.io/google-lens), and [Lens documentation](https://www.searchapi.io/docs/google-lens).
- DataForSEO: [Google Images overview](https://docs.dataforseo.com/v3/serp-google-images-overview/), [advanced result schema](https://docs.dataforseo.com/v3/serp/google/images/task_get/advanced/), [Google Images pricing](https://dataforseo.com/apis/serp-api/google-images-api), [minimum payment](https://dataforseo.com/help-center/minimum-payment), and [terms](https://dataforseo.com/terms-of-service).
- DataForSEO reverse image search: [Google Search By Image overview](https://docs.dataforseo.com/v3/serp-google-search_by_image-overview/) and [advanced result schema](https://docs.dataforseo.com/v3/serp-google/search_by_image/task_get/advanced/).
- SerpApi: [Google Images result schema](https://serpapi.com/images-results), [pricing](https://serpapi.com/pricing), and [legal terms](https://serpapi.com/legal).
- Google: [Custom Search JSON API lifecycle and pricing](https://developers.google.com/custom-search/v1/overview), [Custom Search response schema](https://developers.google.com/custom-search/v1/reference/rest/v1/Search), [Vertex AI website search and pricing](https://cloud.google.com/use-cases/site-search), [Agent Search image search](https://docs.cloud.google.com/generative-ai-app-builder/docs/image-search), [Gemini image grounding](https://ai.google.dev/gemini-api/docs/image-generation#grounding-with-google-search-for-images), [Cloud Vision Web Detection](https://docs.cloud.google.com/vision/docs/detecting-web), [Cloud Vision pricing](https://cloud.google.com/vision/pricing), and [Google Terms](https://policies.google.com/terms?hl=en-US).
- Microsoft: [Bing Search API retirement](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement) and [Grounding with Bing Search](https://learn.microsoft.com/en-us/azure/foundry-classic/agents/how-to/tools-classic/bing-grounding?pivots=overview&tabs=python&view=azure-python-preview).
