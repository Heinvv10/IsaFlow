# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-10-08 (R-035 follow-up PR A): Rules tab split out of the page; create/edit/toggle; starter preview; the panel's no-active-rule note.
- 2026-10-08 (review r3): the form refuses a name with no visible character (`hasVisibleCharacter`); tests pin busy cleanup on error paths, the page-load spinner guard and the form's 100-character bound.
- 2026-10-08 (review r2): busy state is a per-rule Set (one write's cleanup cannot re-enable another rule's buttons); the page's `fetchData` is sequenced (`loadSeq`) for requests, its error and the spinner, beside `rulesSeq`; amounts in whole cents, names ≤ 100.
- 2026-10-08 (review r1): true coupled-payment notes; delete confirmation; `parseAmount` bounded by numeric(15,2); `system` not offered; rules loads sequenced in the page (`rulesSeq`) so a late reload cannot overwrite a newer one.
