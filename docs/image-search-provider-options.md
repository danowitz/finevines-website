# Image-search provider decision

Date: 2026-08-13
Final decision: 2026-08-16

## Production choice

Use **Brave Image Search as the sole unattended bottle-image provider**.
Brave supplies direct image URLs, source-page provenance, indexed dimensions,
and a supported API backed by its independent search index. Its current $5
monthly credit offsets roughly 1,000 ordinary search requests, which is expected
to cover normal new-product volume.

Every provider call must remain visibly distinct from an empty result. An
authentication, permission, quota, or transport failure leaves the wine due and
must never become a cached miss.

## Retired alternatives

- **Serper Google Images** added measurable coverage in a frozen 30-wine test:
  four visually verified winners came from Serper. It was nevertheless retired
  because it is not required for the catalog to operate and its smallest paid
  purchase is $50 for credits that expire after six months. Difficult wines may
  remain on the neutral image fallback rather than creating that permanent
  account and cost obligation.
- **Google Custom Search JSON API** contributed useful historical images but was
  retired after Brave replaced the active path and Google announced the API's
  2027-01-01 discontinuation.
- **Google Cloud Vision Web Detection** was retired after a frozen comparison
  made 46 requests, downloaded 206 expansion images, and recovered zero wines.

Existing accepted bottle images and their source provenance remain part of the
catalog. Retiring a discovery provider does not withdraw verified photography
that it previously helped locate.

## Operating sequence

1. Query Brave with the full catalog identity, including vintage.
2. Apply source-policy, download, identity, visual-consensus, watermark, and
   publication-quality gates.
3. If unresolved, retry through the existing recovery scopes when due.
4. Send the remaining difficult wines to protected human review or leave the
   neutral “Product image unavailable” fallback in place.

## Primary source

- Brave: [Image Search API documentation](https://api-dashboard.search.brave.com/documentation/services/image-search),
  [API reference](https://api-dashboard.search.brave.com/api-reference/images/image_search),
  and [pricing](https://brave.com/search/api/).
