# Reviewer-Pasted Bottle Images

## Outcome

An authorized FineVines reviewer can open Google Images from an individual wine card, paste a known-good bottle image into that same card, and queue it through the existing immutable review-action workflow.

## Behavior

- Each wine in a review package carries the pipeline's exact recorded `query` as `searchQuery`.
- The card opens Google Images with `searchQuery` verbatim. It never rebuilds, expands, or improves that query.
- The global wine-search field is removed.
- Each card contains: `Click here, then press Control V to paste your image.`
- Pasting JPEG, PNG, or WebP displays a local preview with **Clear** and **Use this image**.
- **Clear** discards only the browser-local preview.
- **Use this image** requires an eligible reviewer, validates a supported image no larger than 10 MiB, then stores the bytes and queues one immutable action bound to package, catalog commit, SKU, and wine revision.
- The reviewer's selection is authoritative identity proof. Reviewer-supplied images do not require a source URL and do not pass through automated identity, source-host, background, crop, or resolution gates.
- Technical integrity remains mandatory: supported image signature, size limit, immutable byte length/hash, current package/wine/reviewer binding, and successful production image decoding/normalization.
- The wine card disappears only after the server confirms that the upload and action were queued.

## Storage and processing contract

The Edge console writes reviewer bytes to an immutable action-specific object before writing the immutable action and pending pointer. The action records MIME, byte length, SHA-256, and storage name. The Go processor verifies all four before normalization, records the image as `reviewer-supplied`, and leaves the pending pointer in place until normal deployment finalization writes a durable receipt.

## Public test seams

1. `buildReviewDraft` preserves the manifest record's discovery query verbatim.
2. The authenticated review-console HTTP interface rejects cross-origin, missing-CSRF, unsupported, oversized, or stale reviewer-image submissions; a valid request writes image, action, and pending objects in dependency order.
3. `reviewactions.Prepare` accepts a bound reviewer-supplied image without source provenance, verifies immutable byte metadata, normalizes it, and records reviewer provenance.
4. The authenticated browser document renders per-card Google/paste controls, local preview/clear/queue behavior, and no global wine filter.
