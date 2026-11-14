# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-04-24: Sage migration moved admin-side + self-service email change (1ec39129)
- 2026-04-24: revert "fix(sage-migration): replace dead super_admin gate with owner/admin"
- 2026-04-24: fix(sage-migration): replace dead super_admin gate with owner/admin
- 2026-04-18: codemod handlers onto withAuth / withUserAuth
- `chart-of-accounts`: a `systemAccountMap` that would change the BANK role's holder is owner/admin only (403 for a manager, nothing written); any role it moves is audited (`core/migrationCoaRoleMoves.ts`).
