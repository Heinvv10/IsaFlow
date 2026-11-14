# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-10-02 (D4 round 10): DELETE can be made from the CHILD side — with the child as the active company, `?parentCompanyId=` withdraws the link that exposes it (still `withWriteAccess` on the active company), so a child's own owners can end a grant someone else made; giving both ids is a 400. `childCompanyId` / `parentCompanyId` are UUID-checked (400) before any cast. Test: `tests/unit/api/groupRoutesIdsAndChildWithdraw.test.ts`.
- 2026-10-02 (D4 round 9): attaching a subsidiary (POST) needs a write role in the CHILD company (`userCanWriteCompany`), not membership — attaching it exposes its ledger to the parent's consolidation.
- 2026-10-02 (D4 round 8): `companies.ts` POST (attach a subsidiary) and DELETE (withdraw one) are wrapped in `withWriteAccess` — the active company is the parent, so its own role decides; a viewer gets 403 before any write, GET still reads. Test `tests/unit/api/consolidationCompaniesWriteAccess.test.ts`.
- 2026-04-24: second pentest batch — M1, M6, M14/M15, M20, M21, L4 + codemod
- 2026-04-18: codemod handlers onto withAuth / withUserAuth
- 2026-04-15: BL-106..BL-117 — apply withCsrf to 100 non-money-moving routes (Batch H1)
