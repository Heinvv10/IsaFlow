# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-10-24 (S-07d, migration 937): portal contacts are written on the migration_admin pool (`portalContactsService`).
- 2026-10-20: `withWriteAccess` on all 23 mutating AFS routes (S-02/S-03); tests `tests/unit/security/viewerMutationRoutes.test.ts`.
- 2026-10-16 (migration 894): `report-templates`' `entity_type` query is an AFS template key (`AFS_TEMPLATE_KEYS` = pty|cc|trust), not a company entity code. `pis-score` PUT's optional `entityType` writes `companies.entity_type`, so it takes the eight SA codes (`ENTITY_TYPE_CODES`); the old pty|cc|trust `EntityTypeEnum` is gone (894's CHECK refuses 'pty').
- 2026-04-24: remediate pentest findings — 2 Critical + 11 High
- 2026-04-24: payg phase 1 — flow wallet / metering / admin + tenant surfaces
- 2026-04-21: three schema-mismatch 500s from PR #31 (#32)
- 2026-04-21: phases 3-8 — IFRS notes, report templates, PIS, ratios, VAT recon, multi-entity
