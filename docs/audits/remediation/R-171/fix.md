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
| `DailyDigestResult` | Adds `recipientsFailed: number` (additive — `recipientsNotified`, `recipientsSkipped`, `errors` unchanged in name and shape) |
| `runDailyDigest`, per-user send | `recipientsNotified++` only inside `if (emailResult.success)`; the `{ success: false }` branch does `recipientsFailed++` alongside the existing `errors.push` |
| `runDailyDigest`, per-user catch (throw) | Also does `recipientsFailed++` alongside the existing `errors.push` — a thrown send is a failed send too, and was already correctly excluded from `recipientsNotified` |
| `runDailyDigest`, "Daily digest complete" log | Includes `recipientsFailed` alongside the existing fields |

The `log.info('Practice digest sent', …)` line moved inside the success branch too — it
previously logged "sent" even when the send had failed.

The route (`pages/api/cron/practice/daily-reminders.ts`) forwards the whole result object
unchanged; no route or consumer change needed. Nothing else reads `DailyDigestResult` (checked:
only the route and the two test files). `practiceMonthlyReportService.ts` already counts only
successes and was NOT touched — that cron belongs to R-168.

## Tests

`tests/integration/r171-practice-digest-counts.int.test.ts` (4 tests, real PG, through the route
handler, fixture `isaflow-fixture-r171-goal` cloned from `isaflow-fixture-r159`):

- runs to completion: 200
- `recipientsNotified` counts only the successful send, not the soft failure or the throw (`1`/`2`)
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

**Concurrency note (important for anyone running the full local integration suite).** The digest
cron has no company filter — `loadActiveCompanies` scans every active company — so
`recipientsNotified`/`recipientsFailed` on the response are GLOBAL totals across the whole fixture,
not scoped to this test's own company. Vitest runs test FILES in parallel by default
(`vitest.integration.config.ts` sets no `fileParallelism: false`), and this file and R-162's both
drive the same cron against the same real Postgres fixture. Proven directly: running the two files
together with default parallelism failed intermittently (`expected 6 to be 1`, `expected 3 to be
1` — the exact count depends on how much of the sibling suite's fixture data existed at the
instant this test's own cron call ran), while three repeats with `--no-file-parallelism` passed
`24/24` every time. Same class of hazard as
`feedback_controls_integration_deadlocks_in_parallel.md` (memory). **Run this file alone, or with
`--no-file-parallelism`, alongside r162 or any other suite that also emails through this cron.**
R-162 itself never hit this because it only asserts company-scoped digest content
(`digestTo`/`mine`), never the raw global counters — this test's whole point is the counters
themselves, so it can't dodge the hazard the same way.

Unit tests: `tests/unit/services/practice/practiceNotificationService.test.ts` — updated the
existing per-user-failure case to assert `recipientsNotified: 0` / `recipientsFailed: 1` (was
previously only checking `errors`), added a new case for a thrown send
(`recipientsNotified: 0` / `recipientsFailed: 1`), and added `recipientsFailed: 0` to the
"returns zeros when no companies exist" exact-equality case. `bunx vitest run
tests/unit/services/practice/practiceNotificationService.test.ts` → `Tests 9 passed (9)`.

## Mutation table

Each guard was removed in the working file, the relevant suite was run, and the file was restored
from a backup copy.

| Guard removed | Test that went RED | Assertion |
|---|---|---|
| `recipientsNotified++` moved back outside the `if (emailResult.success)` branch (the original bug) | integration: "recipientsNotified counts only the successful send, not the soft failure or the throw" | `expected 2 to be 1` |
| same mutation | unit: "continues processing on per-user email failure, and does not count it as notified" | `expected 1 to be +0` |
| `result.recipientsFailed++` removed from the `catch` block (throw path) | unit: "a send that throws is counted as failed, not notified (R-171)" | `expected +0 to be 1` |

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
