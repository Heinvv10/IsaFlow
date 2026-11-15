# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-10-24 (S-07d, migration 937): `auth/verify` refuses a token that is not 64 hex characters and rate-limits 20 a minute per IP (`afs-portal-verify:<ip>`) before the magic-link lookup takes a migration_admin connection; the lookup and consume run on that pool.
