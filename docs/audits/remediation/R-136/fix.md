# R-136: fixed with R-135 (2026-09-29)

The leave write routes are now wrapped in `withWriteAccess`:

- `pages/api/payroll/leave/[id].ts` (PUT and DELETE);
- `leave/index.ts` (POST);
- `leave/types.ts` (POST).

Owner, admin and manager can still write. A viewer gets 403 before any write.

The repro, tests, mutations and census are in `../R-135/fix.md`.
