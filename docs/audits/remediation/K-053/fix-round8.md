# K-053 round 8 — gates and mutation record

Branch `fix/audit-k053-aging-soft-deleted`. Round 8 answers the round-7 review:
HIGH-1 (`unappliedCashService`), MEDIUM-1 (`vatReconciliationService`), MEDIUM-2
(the reconciliation claim) and the LOW (the decorative route-vs-service equality).
The narrative disposition is in `fix.md`; this file is the evidence.

## Gates

| Gate | Result |
|---|---|
| `bun run ci` (type-check, lint, agent-docs, security-guards, unit, migration-naming, production build) | **all checks passed** |
| `bun run test:unit`, `DATABASE_URL` unset | 9440 passed / 234 skipped, 793 files |
| `k053-*.int.test.ts`, real PostgreSQL, `--no-file-parallelism` | **17 files / 79 tests passed** |

The k053 integration set grew from 13 files / 65 tests to 17 / 79. New files:

- `k053-unapplied-cash-delete-reversal.int.test.ts` — H-1, both directions.
- `k053-afs-notes-tie-to-gl.int.test.ts` — AFS notes 10 and 16, disclosure notes 3 and 4.
- `k053-group-and-integrity-tie-to-gl.int.test.ts` — group dashboard, both document
  integrity checks.
- `k053-statement-recon-variance.int.test.ts` — the supplier-statement variance.
- `k053-aging-route-vs-service-rewind.int.test.ts` — the LOW: the ageing routes and
  services on a book with a later document and a later settlement.

## Mutation proof

Every file that carries `documentInLedgerAsAtFragment` — 34 of them, enumerated by grep over
`src/` and `pages/` and NOT from the fix list — was reverted to the no-predicate form
(each `${documentInLedgerAsAtFragment(...)}` replaced by `TRUE`), the whole k053 integration
set was run, and the file was restored from a FILE COPY. No `git checkout --`.

**32 RED, 2 GREEN.** The two GREEN are `pages/api/portal/chat.ts` and
`src/modules/accounting/services/ar/portalService.ts`, both unreachable behind the
pre-existing 42703 registered as R-055 — see the per-file table in `fix.md`. Round 7's
sweep, by contrast, was 13 RED with 10 of the 15 fixed files revertible; those 10 are now
RED except the one portal endpoint among them.

RED includes both directions where the surface allows it: the fixtures carry a document
soft-deleted through the real service (its GL reversal dated TODAY) AND one in the
pre-branch shape (`deleted_at` set, approval journal never reversed), so both dropping what
the GL still carries and keeping what it has released turn the assertions red.

## Not done, and why

- `pages/api/portal/chat.ts` and `ar/portalService.ts` — 42703 before the predicate is
  reached (R-055). Verified against the fixture and against `master`; deliberately untouched.
- The ageing routes' divergence from the ageing services on `invoice_date <= as-at` and on
  the `amount_paid` rewind — measured at `LATE - PAID` and registered as R-056. It predates
  this branch and is not a soft-delete question.

## Over the 300-line cap

Measured, not recalled. Round 8's two production files:
`reconciliation/unappliedCashService.ts` 268 → 289 (under the cap, and stays under);
`reports/vatReconciliationService.ts` 393 → 420 — already over the cap on `master`, and the
change is three one-line predicates plus their comments, which were shortened rather than
repeated three times. Splitting a file that was already 93 lines over is an adjacent
refactor, not this fix.

Test files: `k053-figure-surfaces-tie-to-gl.int.test.ts` 402 → 522, and of the five new
files four are under the cap (173, 198, 284, 295) with
`k053-aging-route-vs-service-rewind.int.test.ts` at 315. Test files over the cap are
disclosed in `fix.md` (LOW-3, round 7). Splitting a k053 fixture file duplicates its
`beforeAll` against one shared database, which is what the four new files exist to avoid.
