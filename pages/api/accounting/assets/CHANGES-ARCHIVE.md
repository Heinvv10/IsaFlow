# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-11-07: `dispose` validates `proceeds` (400 before any write; was a 500 from the journal)
- 2026-11-07: `dispose` refuses a type `assets.disposal_type` cannot store (400, before any write) and logs `asset_disposals`; mig 965 widens the CHECK to `scrap`/`insurance_claim`, so the page's list is unchanged. Earlier disposals have no log row (no backfill)
- 2026-10-05 (round 2): unlink of an absent kind 409; bounded asset lock on create; date range / NUL refused 422
- 2026-10-05: mig 853 — fleet fuel / service records (`fuel`, `service`), `bank-links`, and the asset / fleet link routes rebuilt as annotations
- 2026-09-09: K-026 — `below-threshold` POST gained `withWriteAccess`, a row lock and an already-expensed guard
- 2026-09-09: `afs-summary` K-028/R-007 — additions no longer double-count pre-existing assets, window follows the company's financial year, prior snapshot drops disposed assets, `period` month validated (400 not 500)
- 2026-04-22: 4 Bugsink-surfaced regressions
- 2026-04-19: PRD-04 Enhanced FAR — dual-track engine
