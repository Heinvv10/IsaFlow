# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-11-07: the opening "Balance brought forward" line is an opening-balance check (never matched or missing in IsaFlow); detail adds `openingBalance` and `lines[].isOpeningBalance`
- 2026-10-17: extraction is asynchronous and per page (migration 896); `rematch` and `mark-reconciled` refuse `extracting`/`failed` rows with 409 (`ReconciliationNotReadyError`); see `services/bank/.claude.md`
- 2026-09-10: R-059 — the variance is measured from the AP ageing at the statement date, on creation and on Rematch; match candidates are the ageing's population; Rematch is refused (409) on a reconciled statement
- 2026-04-24: remediate pentest findings — 2 Critical + 11 High
- 2026-04-22: PRD-05 Phase 7 — bank + supplier statement PDF reconciliation
