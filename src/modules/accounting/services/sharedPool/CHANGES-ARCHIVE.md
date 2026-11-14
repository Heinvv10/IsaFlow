# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-10-21: created (migrations 905 and 931; 931 was first numbered 906 and was renumbered on 2026-10-23, before it was applied anywhere, so it runs after 930 and lists its two definers in `app_definer_reviews`). Tests: `tests/unit/sharedPool/*`, `tests/unit/services/bank/autoPostSharedPoolExclusion.test.ts`, `tests/integration/shared-merchant-patterns.int.test.ts`, `tests/integration/category-mapping-header.int.test.ts`.
- 2026-10-21 (merged PR 1's decisions): gated the job, both routes, the reader and the page on `MERCHANT_SHARING_ENABLED`.
- 2026-10-21 (review round): channel tokens (filter version 2), the pool never votes for itself, all-or-nothing publish, audited single-run admin trigger, no header accounts, no alias in two categories.
