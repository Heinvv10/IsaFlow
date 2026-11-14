# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-10-15 (after the first prod snapshot, Velocity Fibre, 90,965 lines): migration 893 rewrites the six read
  policies so `audit_snapshot_reader` runs once per query (InitPlan), not per row — the lines read went from 7.2 s to
  0.17 s on prod, and a verify on a loaded box had run past the 95 s statement_timeout. `take_audit_snapshot` honours
  `dry_run` (`snapshotPreview.ts`: key, slot, chain lock, size cap, line count in the take's own kind of transaction; writes nothing; cannot foresee SNAPSHOT_TOO_SLOW).
- 2026-10-12: created (step 4, migration 891); review rounds 1–2 (see the PR #702 reconciliation comments).
