# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-09-11 — created (Task 6, bank sync v1 Release 1).
- 2026-09-11 — `pages/api/accounting/bank-feeds/[id]/extension-ingest.ts` cut over to this service as its only caller (Task 7).
- 2026-09-11 — final review: lazy import batch, per-account advisory lock, daily cap under the lease, reconciliation_id is processed, provider_updated_at monotonic, whole-cents amounts.
