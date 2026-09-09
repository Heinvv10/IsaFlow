# Fiscal period and company-lock shared controls

Base `ac7735f4`, isolated `feat/mcp-forensic-period-writers-20260909`. Scope: fiscal close/lock/reopen/year-close, company lockdown changes and VAT lock records through existing shared services. No direct posted writers outside these services, external filing, deploy or production changes.

## Contracts and authority

- Fiscal period references use owned UUIDs; fiscal year uses four-digit natural identity; VAT uses strict `YYYY-MM-DD/YYYY-MM-DD`; company lockdown uses an immutable root632 intent UUID.
- New explicit `write:locks` scope and current `locks.canApprove` permissions govern lock mutation. Existing grants of `write:controls` do not silently gain this authority. Configured active `any` policies all apply with independent human decisions. Monetary threshold/aggregate rules cannot evaluate nonfinancial material and fail closed. No invented mandatory-policy IDs or zero financial amounts.
- `materializePeriodOperation(ctx,ref)` returns null amount/currency, no beneficiaries, and actual period/year/VAT end date. Company change uses the database SAST execution day while its target cutoff remains separately bound in the immutable intent.
- All period operations bind actual selected period rows, company lock/currency facts, journal headers, lines and account properties. Year closure emits both the synthetic year event and a real before/after version event for each changed fiscal period. Untracked sources receive a baseline observation before mutation.
- Journal/line populations are capped at 10000/50000 with LIMIT+1 and explicit refusal; no truncated evidence is approved. Larger periods need a separately implemented bounded server-job path.

## Shared service behavior

`closePeriod`, `lockPeriod`, `reopenPeriod`, `closeYear` preserve existing arguments/results and add optional `{approvalId}`. Read-check-write transitions execute under locked period rows and the shared approval savepoint. Existing prior-open-period and locked-state rules remain. `closePeriodWithReadiness` forwards approval references but retains its existing strict MCP checklist behavior and dry-run handling; ordinary attended close does not acquire a blanket readiness prohibition.

`requestLockdownChange(ctx,{enabled,date})` creates a person-bound immutable intent and event. `updateCompany(id,input,{lockdownIntentId,approvalId})` checks current owner/admin membership, exact active tenant, target equality and intent requester before executing. Unrelated company settings retain their existing mapping and COALESCE behavior with mandatory material events. Private raw UPDATE stays in the same module so the extracted helper does not expose an alternate unguarded writer. Platform-admin cross-tenant adapters need their own explicit target-tenant context; this change does not invent one.

`lockVatPeriod` preserves the legacy figures/actor parameters for callers but derives persisted figures from the real owned VAT201 report and actor metadata from the active principal. Caller figures and labels cannot certify the filed amounts. Existing natural-key repeat calls return the immutable original lock with `created:false`. Company FOR UPDATE serializes lock insertion with controlled GL's company FOR SHARE. Root owns the corresponding GL VAT-affecting posting guard; storing a lock alone is not a claim of posting closure.

## Executed evidence

- Six unit RED cases reproduced unauthenticated mutation boundaries for close/lock/reopen/year/company/VAT (`/tmp/period-boundary-red.log`); all six then passed with real context rejection before mocked SQL.
- Five reference parser tests pass. Materializer dependency `bae1cf51` contains this code and proof.
- Two oversized-population tests reproduced missing limits against named `bae1cf51` (`/tmp/period-bounds-red.log`), then passed with patch `f54faaaf`.
- Existing readiness and date/read selection tests are included in focused regression checks. Readiness's original three-argument call is retained when no approval reference exists.
- Seven real PostgreSQL cases passed (3.20s, `/tmp/period-pg-green.log`): approval/tenant refusal; close/reopen/lock/replay/events; year child events; stale journal material; lockdown intent requester/target checks, enable/disable and harmless settings; VAT figures from an actually posted 15 input-tax journal instead of forged input, real actor and natural-key idempotency; actual close/post lock wait with posting refusal after committed closure. Uses dedicated opt-in localhost33149 fixture, real app_user RLS/withControlRequest/current permissions and shared services, no SQL/auth mocks. Pool closed and DB lease released.
- First PG run passed six cases and reproduced PostgreSQL's UPDATE privilege requirement for SELECT FOR SHARE on immutable632 intents. The materializer now reads those immutable rows with SELECT while retaining exclusive company and real period/source locks; no grant was broadened.
- Fifty-one focused unit tests passed across new material/dispatcher/boundary and existing fiscal/readiness/date suites. An additional local-midnight company-cutoff regression reproduced the prior-day ISO conversion and passed with the existing fmtDate formatter (`/tmp/period-company-date-red.log`, `/tmp/period-company-date-green.log`). This last date-only adjustment follows the seven-case PG run and is separately unit-proved.
- Focused TypeScript including integration tests and changed-source ESLint passed. Dependencies: root `c386b8bd` scopes/permission/nullable-policy/632 and `14ac0d7d` period dispatch. No actual HTTP socket/browser admission test in this suite; existing services are the tested shared ingress.

Reproduction (Node22.23.1, dedicated fixture env supplied at runtime):

```sh
./node_modules/.bin/vitest run tests/unit/services/controls/period*.test.ts tests/unit/services/fiscalPeriodService.test.ts tests/unit/services/gl/fiscalPeriodCloseService.test.ts tests/unit/services/fiscalPeriodDateMapping.test.ts
./node_modules/.bin/vitest run --config vitest.integration.config.ts tests/integration/controls/periodSharedWriters.int.test.ts
```

No full CI/build or programme-wide completion is claimed. Separate original direct SQL writers, creation/import of fiscal calendars, financial year-end journals, period transport/UI adapters and platform-admin target-tenant workflows remain integration inventory items.
