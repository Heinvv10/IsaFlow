# R-171 — practice daily-digest cron: `recipientsNotified` counted a failed send as delivered

Base: origin/master `66e776d81`. Item source: register (R-171, low), following R-162 (PR #575).

## Reproduction (fixture `isaflow-fixture-r171-goal`, a clone of `isaflow-fixture-r159`)

Driven through the real cron handler (`POST /api/cron/practice/daily-reminders`), same harness as
R-162: as the pool role, `sendEmail` mocked at module scope and scripted per recipient (never
actually sent). One company, three members, each with one overdue task so every one of them
qualifies for the digest regardless of what their send does:

- `r171-success@isaflow.test` → `sendEmail` resolves `{ success: true }`
- `r171-fail@isaflow.test` → resolves `{ success: false, error: '…SMTP timeout' }`
- `r171-throw@isaflow.test` → throws

**On master:**

```
AssertionError: expected 2 to be 1 // Object.is equality
 ❯ tests/integration/r171-practice-digest-counts.int.test.ts
```

`recipientsNotified` came back `2` — both the successful send AND the soft `{ success: false }`
failure were counted as notified. Only the thrown send was excluded, and only by accident: the
`result.recipientsNotified++` line sat after the `sendEmail` call in the same `try` block, so a
thrown error skipped it by jumping straight to `catch`, while a returned `{ success: false }`
fell through to the increment untouched.

## Root cause

`src/modules/accounting/services/practice/practiceNotificationService.ts`, `runDailyDigest`
(~line 178, pre-fix):

```ts
if (!emailResult.success) {
  result.errors.push({ companyId, userId: user.id, error: emailResult.error ?? 'Email send failed' });
}
result.recipientsNotified++;               // ← ran regardless of emailResult.success
```

The cron's JSON response is the only signal an operator (or a future scheduling decision — the
cron is still unscheduled per R-162) has for whether the digest actually reached anyone.
`recipientsNotified` overstated delivery for every soft mail-provider failure (bounce, throttle,
bad address) that didn't throw.

## Fix

| Where | Change |
|---|---|
| `DailyDigestResult` | Adds `recipientsFailed: number` (additive — `recipientsNotified`, `recipientsSkipped`, `errors` unchanged in name and shape). Doc comments on both fields now say exactly what each counts (see below). |
| `runDailyDigest`, per-user send | `recipientsNotified++` only inside `if (emailResult.success)`; the `{ success: false }` branch does `recipientsFailed++` alongside the existing `errors.push` |
| `runDailyDigest`, per-user send `catch` (throw) | Also does `recipientsFailed++` alongside the existing `errors.push` — a thrown send is a failed send too, and was already correctly excluded from `recipientsNotified` |
| `runDailyDigest`, "Daily digest complete" log | Includes `recipientsFailed` alongside the existing fields |

The `log.info('Practice digest sent', …)` line moved inside the success branch too — it
previously logged "sent" even when the send had failed.

The route (`pages/api/cron/practice/daily-reminders.ts`) forwards the whole result object
unchanged; no route or consumer change needed. Nothing else reads `DailyDigestResult` (checked:
only the route and the two test files). `practiceMonthlyReportService.ts` already counts only
successes and was NOT touched — that cron belongs to R-168.

### Review round 1 (blind, 2 findings — both fixed in a follow-up commit)

**LOW — a pre-send query error was counted as a failed SEND.** The per-user `try` wrapped
`queryOverdueTasks`, `isTimesheetMissing` AND `sendEmail` together, so a query error before any
send was ever attempted also did `recipientsFailed++` — the same misleading-count class this
item exists to fix, just one layer up. Fixed by splitting the per-user loop into two `try` blocks:
the first covers the two queries and `continue`s to the next user on error (pushes to `errors`,
does NOT touch `recipientsFailed`/`recipientsNotified`); the second wraps only `sendEmail` and is
the sole place either counter moves. `DailyDigestResult`'s field comments now say this explicitly:
`recipientsFailed` counts a `sendEmail` call that resolved `{ success: false }` or threw — nothing
upstream of the send. Test: `tests/unit/services/practice/practiceNotificationService.test.ts` —
"a query error before any send lands in errors but is not a failed send (R-171 review LOW)"
(`sqlMock.mockRejectedValueOnce` on the overdue-tasks query; asserts `sendEmail` was never called,
`recipientsFailed` is `0`, and the query error is the sole `errors` entry).

**HIGH — the integration test asserted exact GLOBAL counts, which races under default file
parallelism.** `recipientsNotified`/`recipientsFailed` are totals over EVERY active company
(`loadActiveCompanies` has no filter), and `tests/integration/**` runs with vitest's default file
parallelism — proven to flake when r162's suite (which also emails through this cron) is present
in the same DB at the same instant (`expected 6 to be 1`, then `expected 3 to be 1` on a retry —
see the concurrency note below, which predates this fix and is now stale for the count assertion
specifically, though the underlying cron-scans-everything fact it documents still holds and still
governs the OTHER checks in this file). Fixed by deriving the EXPECTED counts from this same
invocation's own `sendEmail` mock outcomes instead of a hardcoded number: the mock is now scripted
to succeed for anyone it doesn't specifically fail/throw for (so it also "handles" any other
company's qualifying recipient the same run processes), and every call pushes its classification
(`'success' | 'fail' | 'throw'`) onto an `outcomes` array, cleared immediately before the one
invocation under test. `expectedNotified`/`expectedFailed` are then `outcomes.filter(...)`.length,
and the assertion is `data.recipientsNotified === expectedNotified` (not `=== 1`). This holds
exactly regardless of how many OTHER companies/users the same cron run also touches, because every
one of them is intercepted by this file's own `sendEmailMock` (the only `sendEmail` this module
graph has) and classified the same way the counter itself must classify it. Proven: 6 back-to-back
runs of `r171 + r162` together with vitest's DEFAULT parallelism (no `--no-file-parallelism`) all
passed `24/24`. The mutation (reverting the notified/failed split) still turns the exact named
integration test red (`expected 2 to be 1`) — this assertion is derived, not weakened.

## Tests

`tests/integration/r171-practice-digest-counts.int.test.ts` (4 tests, real PG, through the route
handler, fixture cloned from `isaflow-fixture-r159`):

- runs to completion: 200
- `recipientsNotified`/`recipientsFailed` exactly match this run's own `sendEmail` outcomes
  (derived, not hardcoded — see the HIGH fix above)
- both the soft failure and the throw land in `errors` with `companyId`/`userId`
- the successful send was actually captured (mocked, never really sent); the throwing recipient
  is never recorded as sent

Run:
```
ISAFLOW_DISPOSABLE_AUTH_TEST=1 DATABASE_URL=postgres://postgres:fixture@127.0.0.1:55484/isaflow_schema_fixture \
PLATFORM_ADMIN_DATABASE_URL=postgres://postgres:fixture@127.0.0.1:55484/isaflow_schema_fixture \
GOTRUE_URL=http://127.0.0.1:1/auth/v1 DATABASE_SSL=disable \
bunx vitest run --config vitest.integration.config.ts tests/integration/r171-practice-digest-counts.int.test.ts
```
→ `Test Files 1 passed (1)`, `Tests 4 passed (4)`.

`tests/integration/r162-practice-daily-digest.int.test.ts` re-run against this branch: still
`Tests 20 passed (20)`.

**Concurrency: fixed for the count assertion, still true as a fact about the cron.** The digest
cron has no company filter — `loadActiveCompanies` scans every active company — so
`recipientsNotified`/`recipientsFailed` on the response are GLOBAL totals across the whole
fixture, including whatever other suite's rows exist in the same real Postgres DB at the same
instant under vitest's default file parallelism (`vitest.integration.config.ts` sets no
`fileParallelism: false`). That's still true and is why the per-company/per-error checks in this
file filter by `companyId`. What changed after review round 1: the COUNT assertion no longer
depends on isolation to be correct (see the HIGH fix above) — **6 back-to-back runs of
`r171 + r162` together, with vitest's DEFAULT parallelism (no `--no-file-parallelism`), all
passed `24/24`**. `--no-file-parallelism` is no longer required for this file; it was only ever a
workaround for the hardcoded-count version. Same underlying hazard class as
`feedback_controls_integration_deadlocks_in_parallel.md` (memory) — the fix here is deriving the
expectation from the same run's own evidence, not avoiding the hazard by serialising.

Unit tests: `tests/unit/services/practice/practiceNotificationService.test.ts` (10 tests) —
updated the existing per-user-failure case to assert `recipientsNotified: 0` / `recipientsFailed: 1`
(was previously only checking `errors`), added a case for a thrown send
(`recipientsNotified: 0` / `recipientsFailed: 1`), added `recipientsFailed: 0` to the
"returns zeros when no companies exist" exact-equality case, and added the LOW fix's case (a
pre-send query error: `sendEmail` never called, `recipientsFailed: 0`, one `errors` entry). `bunx
vitest run tests/unit/services/practice/practiceNotificationService.test.ts` → `Tests 10 passed
(10)` (246/246 across the whole `tests/unit/services/practice/` directory).

## Mutation table

Each guard was removed in the working file, the relevant suite was run, and the file was restored
from a backup copy.

| Guard removed | Test that went RED | Assertion |
|---|---|---|
| `recipientsNotified++` moved back outside the `if (emailResult.success)` branch (the original bug) | integration: "recipientsNotified/recipientsFailed exactly match this run's own sendEmail outcomes" | `expected 2 to be 1` |
| same mutation | unit: "continues processing on per-user email failure, and does not count it as notified" | `expected 1 to be +0` |
| `result.recipientsFailed++` removed from the send `catch` block (throw path) | unit: "a send that throws is counted as failed, not notified (R-171)" | `expected +0 to be 1` |
| pre-send `catch` (query error) restored to also do `result.recipientsFailed++` (undoing the LOW fix's split) | unit: "a query error before any send lands in errors but is not a failed send (R-171 review LOW)" | `expected 1 to be +0` |

## Dev verification (read-only, no email sent)

`runDailyDigest` issues SELECTs only — `loadActiveCompanies`, `queryOverdueTasks`,
`isTimesheetMissing`, `listCompanyUsersForSystem` — confirmed by reading the file; `sendEmail` is
the only external effect and is mocked. Ran from this branch against `isaflow_dev` in a throwaway
vitest file (not committed), mocking the mailer two ways:

```
variant 1 (mailer always succeeds): companiesProcessed 5796, recipientsNotified 0, recipientsFailed 0, recipientsSkipped 17, errors 0
variant 2 (mailer always fails):    companiesProcessed 5796, recipientsNotified 0, recipientsFailed 0, recipientsSkipped 17, errors 0
```

Same as R-162 found: **dev has 0 qualifying recipients today** (17 skipped, same figure R-162's
fix.md recorded) — nobody has an overdue task or a missing timesheet under the R-162 recipient
rule right now, so neither variant reaches the send step and `recipientsFailed` can't show
non-zero on dev today. The fixture suite above (one forced success, one forced soft failure, one
forced throw) is the substantive evidence for the counting fix, exactly as R-162's fix.md
anticipated for this item.

## Scope

- Only `practiceNotificationService.ts`'s `runDailyDigest` was touched. `practiceMonthlyReportService.ts`
  (R-168's item) already counts only successes and was left alone.
- No migration. No historical data impact — the cron has never run on prod (R-162 fix.md: no
  timer, no crontab, zero "practice daily digest" triggers in the retained prod journal). This
  fix only changes what the response counts; it doesn't change who gets emailed or what's queried.
- No deploy.
