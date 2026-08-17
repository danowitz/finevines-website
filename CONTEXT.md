# Fine Vines Catalog

Fine Vines maintains a public wine catalog whose bottle photographs may be proposed automatically or supplied by an authorized reviewer.

## Language

**Review candidate**:
A proposed bottle image bound to one wine revision and presented for an explicit human decision.
_Avoid_: Option, result

**Reviewer-supplied candidate**:
A review candidate pasted by an authorized reviewer. The reviewer's explicit selection is authoritative proof that its pixels depict the intended wine, so a source URL and automated image-identity gates are not required.
_Avoid_: Unverified candidate, source-less upload

**Discovery query**:
The exact image-search string recorded by the pipeline run that produced a wine's review candidates. The review console preserves it verbatim for its Google Images link instead of reconstructing it from catalog fields.
_Avoid_: Search hint, improved query

**Queue reviewer image**:
The single operation initiated by **Use this image** that immutably stores the pasted image and creates its bound review action. A paste remains browser-local until this operation succeeds.
_Avoid_: Upload then approve
