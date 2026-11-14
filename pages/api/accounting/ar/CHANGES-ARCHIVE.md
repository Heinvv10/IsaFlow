# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-09-29 (R-157): `invoice/[id]/portal-link` GET only reads. A GET passes `withCsrf` and `withWriteAccess`, so a GET that minted let a viewer create a permanent public token; mint with POST. A non-UUID `id` is a 400 and an ineligible invoice a 404 (both were 500s).
- 2026-04-24: second pentest batch — M1, M6, M14/M15, M20, M21, L4 + codemod
- 2026-04-24: PRD-06 Phase 6 sent-folder mirror + dunning evidence seal
- 2026-04-24: PRD-06 Phase 5+ follow-ups — cron timer, inbound parser, overrides, edit UI
- 2026-04-23: dunning engine — templates, ladder cron, response webhook
- 2026-04-23: Phase 4 receipt → invoice auto-match
