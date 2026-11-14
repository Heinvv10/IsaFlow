# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-09-25: `[id]/post` opts in to the s16(3) late input-VAT claim (`allowLateInputClaim: true`); the response's `claim.lateClaim` names the claim date and the locked period.
- 2026-09-24 (document-line account guard): `[id]/lines/[lineId].ts` PATCH refuses coding a line onto an inactive or foreign account via `gl/documentLineAccountGuard.assertDocumentLineAccounts` — only when `glAccountId` is actually in the body, so omitting it still works on a line whose *existing* account went inactive under it. POST create, POST add-line and `mileage-trip.ts`'s add-line branch now refuse the same way — the check moved into `expenseClaimService.createClaim`/`.addLine` themselves, ahead of every write (see `expense/.claude.md`), so all three routes' catches just map `DocumentLineAccountRefusal` to 400.
- 2026-09-24 (R-105): POST create and POST add-line claim each line's source document (see business rules). Before, `sourceDocumentId` was written unchecked: a slip posted through capture went on a manual claim too (input VAT claimed twice), and another tenant's document id was accepted because the FK check bypasses RLS.
- 2026-04-24: second pentest batch — IDOR/authz hardening via codemod
- 2026-04-22: expense claim line PATCH/DELETE + default mileage GL
- 2026-04-22: PRD-05 Phase 10 — employee expense claims + mileage (initial drop)
