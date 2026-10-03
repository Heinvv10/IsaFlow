# R-188: DEFAULT_AUTH_POOL_MAX 20 -> 10

## Defect
`AUTH_POOL_MAX` sizes four pools (authPool, withExtensionToken, bearerPipeline, platform-admin
app pool). At the default of 20 that is 80 connections per process against a shared Postgres
`max_connections` of 100. Golden Paths hit "remaining connection slots are reserved" on
2026-10-02. R-182's fix.md (connection budget) advised a lower default.

## Decision
Hein, 2026-10-03 (goal file `.claude/handoffs/2026-10-03-r183-r187-pool-budget-goal.md`): default 10.

## Fix
`DEFAULT_AUTH_POOL_MAX = 10` in `src/lib/limits/poolLimits.ts`. The semaphore and two routes changed
in review (rounds 1-3, below): the render-slot clamp is silent for an unset default, invalid values are
logged as invalid, a value that floors below 1 (`0.5`) is invalid, and `ai-narrative`/`ai-forecast` bound
their provider fetch. Every pool reader still goes through `authPoolMax()`.

## Behaviour changes (verified from code and tests)
- Four AUTH pools: 80 -> 40 connections per process. Per-process total of every pool at the
  defaults: 117 -> 77 plus 2 per in-flight verify-email request and 1 per impersonation write (10 neon + 40 auth + 10 admin + 10 rate-limit + 5 invite + 2 accept).
  R-182/fix.md's budget table is historical and left as written.
- `renderSemaphore` ceiling is `floor(authPoolMax() / 4)` (`maxConcurrentCeiling()` in renderSemaphore.ts): 5 -> 2 at the
  default. Its own default of 3 renders is therefore clamped to 2, silently while `PDF_MAX_CONCURRENT_RENDERS` is unset or blank (round 1: prod runs on defaults, so a warning would fire on every process); an explicit value above the ceiling still warns once.
  3 renders need `AUTH_POOL_MAX` >= 12 written as plain digits (`12.0` is a refused spelling and
  gives 10). Setting `PDF_MAX_CONCURRENT_RENDERS=2` only silences the warning an explicit 3 would log.
- `poolSizeFromEnv` (unchanged code), `AUTH_POOL_MAX` outcomes:
  - unset/blank: 10 (was 20).
  - plain digits 2-100 (incl. 11-100): as given, unchanged, silent.
  - refused spelling with a finite positive value: `min(10, ceil(value))` for `AUTH_POOL_MAX` (poolSizeFromEnv, unchanged). `15.0`, `20.0`, `+20`,
    `2e1`, `50.0` now give 10 (were 15, 20, 20, 20, 20); `10.0`, `+10`, `1e1` give 10.
  - NaN, 0, negative, Infinity: 10 (unchanged). Floor of 2 unchanged.
- Docs/comments updated: poolLimits.ts JSDoc, renderSemaphore.ts, withAuthPrint.ts,
  `src/lib/auth/.claude.md`, `src/lib/pdf/.claude.md` (AGENTS.md mirrors regenerated).

## Production note (for the PR body)
Prod's env leaves `AUTH_POOL_MAX` unset, so this changes prod pool sizes on the next deploy
(per-process AUTH pools 20 -> 10 each; PDF render concurrency 3 -> 2).

## Tests
`poolSizeFromEnv.test.ts` (default 10; refused spellings above it; 11/20/100 honoured as given),
`poolSizesBuilt.test.ts` (all four AUTH sites build with max 10 unset; 15 honoured),
`renderSemaphore.test.ts` (ceiling 2 at default; queue tests pin a pool of 20 so they stay about the queue).

## Evidence
| File | Result |
|---|---|
| red.unit.log | constant at 20, final tests: 35 failed / 229 |
| green.unit.log | 254/254 (adds rateLimitPoolMax, pgPoolMaxPremise) |
| regression.unit.log | 1071/1071 over tests/unit/{lib/pdf,lib/auth,auth} + the pool suites; withRenderSlot.test.ts needed AUTH_POOL_MAX=20 pinned (its 3-render test was clamped to 2) |
| mutations.log | M1-M6 all killed; baselines 229/229 before and after |

## Round 1 review fixes
- Default clamp is silent (see above); tests: defaults admit 2 renders, `renderQueueBound() === 4`, no warning; blank value likewise. Red `red.r2.unit.log`, green `green.r2.unit.log` (278/278 over the pool, withRenderSlot and packsDownloadRoutes files), mutants M7-M9 killed in `mutations.r2.log`.
- Stale "three"/"quarter, three-quarters" statements corrected (renderSemaphore.ts, withRenderSlot.ts, pdf.ts, packsDownloadRoutes.test.ts, pdf and auth `.claude.md`); the R-182 entry in `src/lib/pdf/.claude.md` restored verbatim.
- Prod env (checked by the orchestrator 2026-10-03, `/home/velo/isaflow/.env.local`) sets none of `AUTH_POOL_MAX`, `PDF_MAX_CONCURRENT_RENDERS`, `PG_POOL_MAX`: prod is on the defaults.

## Round 2 review fixes
- A set but unusable `PDF_MAX_CONCURRENT_RENDERS`/queue-timeout value (`abc`, `0`, `-1`) is logged once as invalid (name, length, digits-only flag, never the text) and the default applies; it is no longer reported as a clamp of the default. An explicit `3` over the default pool still warns `{requested: 3, ceiling: 2}`.
- Tests release every held render in `afterEach`, so a failed assertion no longer cascades. Mutants re-recorded as independent detections in `mutations.r3.log` (M7'-M9', M10-M13). Red `red.r3.unit.log` (4 new tests), green `green.r3.unit.log` 282/282, regression `regression.r3.unit.log` 1120/1120.
- Pool-share wording corrected: bound is up to half the pool; old ceiling 5 renders = 10 of 20 (50%), old default of 3 = 6 of 20, now 2 = 4 of 10 (40%). `QUEUE_BOUND_FACTOR` JSDoc now states it caps queue length, not wait. PPTX route and packs `.claude.md` wording fixed.

## Recorded, not changed
- Each render holds 2 auth-pool connections (its withAuth one plus the print page's re-entry). At the default, 2 renders take 4 of 10 (40%, leaving 6); before, 6 of 20 (30%, leaving 14). The ceiling formula `floor(pool/4)` is kept: the owner's goal set ceiling 2 at pool 10. The alternative is `floor(pool/8)` = 1 at the default (2 of 10, 20%).
- No pool `waitingCount` is logged anywhere, so pool saturation after the change cannot be seen in the logs.
- The render queue bound (2 x the concurrency bound) drops from 6 to 4 at the defaults.
- Rollback: set `AUTH_POOL_MAX=20` (plain `20`; `20.0` gives 10) in the prod env and restart the service (restores pools of 20, ceiling 5, and the previous 3 renders / queue bound 6).

## Round 3 review fixes
- `ai-narrative.ts` and `ai-forecast.ts` are withAuth routes that called Anthropic with no abort, holding an authPool connection idle in transaction for undici's ~300 s default. At a pool of 10 a slow (not failing) provider plus 2 renders could exhaust the pool. Both now use an AbortController: 30 s for narrative (max_tokens 1024), 20 s for forecast (max_tokens 512, the figure nl-query uses for 512). The timer runs until the body is read and is cleared in `finally`. An abort lands in the existing catch, so the route answers 200 with its fallback and the existing quota mapping (an abort counts as use). Tests: `tests/unit/api/aiRoutesFetchTimeout.test.ts` (abort at exactly the bound, fallback answer, no timer left).
- (Superseded in rounds 4 and 5: the final parsing rule is in Round 5.) `usable` in `renderSemaphore.boundedInt` is now `Math.floor(n) >= 1`: `0.5` used to floor to 0 and refuse every export (or give a 0 ms wait) with no invalid log. Cases for both variables run through `acquireRenderSlot`; an acquire-level test at the defaults (2 active, 4 queued, 7th refused). Warn-once key is `name:invalid`; warning tests re-import the module per test.
- `QUEUE_BOUND_FACTOR` of 2 is stated as a chosen length cap, not derived from timings.
- Evidence r4: `red.r4.unit.log` and `red.r4.semaphore.unit.log` (red against the pre-fix code), `green.r4.unit.log` 318/318 at committed `28e1dd830`, `mutations.r4.log` M14-M20 all killed, `regression.r4.unit.log` 1280/1280.

## Not measured
p99 before/after was NOT measured. The only load harness in the repo is
`scripts/audit-2026-04-14/perf-autocannon.sh`; it needs a running app on :3200 and an admin token
file at `/tmp/isaflow-admin-token.env`, neither available here, and the effect (slot exhaustion on
a shared Postgres) is not reproducible against an isolated fixture. Risk to watch after deploy:
a pool of 10 per wrapper means a burst of more than 10 concurrent authed requests on one wrapper
queues for up to the 15 s acquire timeout instead of up to 20.

## Round 4 review fixes
- `cashFlowForecastAiService.ts` (route `cash-flow-forecast.ts` `?horizon`, under withAuth) now bounds its Anthropic fetch with an AbortController, 30 s (max_tokens 1000), cleared in `finally` so the `!ok` and `json()` paths are covered. An abort throws, which is the service's failure behaviour for any provider error; the route answers `apiResponse.databaseError` (the DATABASE_ERROR envelope, "Failed to generate cash flow forecast"). Tested through the route.
- `noteAiService.ts` (AFS section ai-narrative, under withAuth): `new Anthropic({ maxRetries: 0, timeout: 30_000 })`; the SDK default is 600 s. Pinned by a constructor-options test. The other `new Anthropic(` is `packAiSummaryService.ts`, which already passes a per-call `AbortController` (30 s and 20 s).
- Tests for all three AI call sites: abort at exactly the bound, a body that never arrives is aborted at the bound (a mutant that clears the timer once headers arrive is red: M27-M29), and no timer is left after an unreachable provider.
- `renderSemaphore` env values must be plain digits >= 1 (`1.9`, `2.5`, `0x3`, `3e0`, `+3` are invalid, as `poolSizeFromEnv` treats pool sizes); the invalid log's `length` is now the trimmed text's length. `fresh()` instances' `renderSlotStats` are asserted empty in `afterEach` (no mutant: it guards against a leak, it does not detect a code defect).
- Register: `ai-narrative.ts`/`ai-forecast.ts` and the new files are in R-188's `affectedPaths`; R-182's entry is byte-identical to origin/master.
- Evidence r5: `red.r5.unit.log` (13/53 red against the round-3 code; the first red attempt had a wrong data mock, fixed and redone), `green.r5.unit.log` 362/362 at `b7cef1b11`, `mutations.r5.log` M21-M29 killed with baselines 53/53 before and after, `regression.r5.unit.log` 1745/1745.

## Round 5 review fixes
- `renderSemaphore.boundedInt` follows `poolSizeFromEnv`'s rule (round 4 had made every refused spelling fall back to the default, which moved the safety knob the wrong way: `PDF_MAX_CONCURRENT_RENDERS=1.0` gave 1 on master, 2-3 after round 4). Plain digits >= 1 as given; any other finite value above 0 gives `min(default, ceil(value))` (`1.0` -> 1, `1.9` -> 2, `0.5` -> 1; `2.5`, `0x3`, `3e0`, `+3` -> 3, then ceiling-clamped); else the default; each warned once as invalid, never as a clamp. Unset/blank stays a silent clamp. That `min(default, ceil(n))` rule applies to the concurrency COUNT only (smaller is safer). For `PDF_RENDER_QUEUE_TIMEOUT_MS` every refused spelling gives the 10 s default, warned as invalid: rounding `0.5` up to a 1 ms wait would refuse every waiter at once (the failure round 3 removed). Plain digits keep their existing clamping.
- `noteAiService.ts`: the SDK `timeout` option covers only the time to the response headers (sdk fetchWithTimeout clears it once fetch resolves), so the call now also passes a per-call `{ signal: AbortSignal.timeout(NOTE_AI_TIMEOUT_MS) }`, as `packAiSummaryService` does. `NOTE_AI_TIMEOUT_MS` is 60 s (claude-sonnet-4-6 at max_tokens 1024 can take tens of seconds; still far under the SDK's 600 s). An abort here throws, the service rethrows it as "AI narrative generation failed", the route answers a 500, and the AI unit counts as used (an abort proves no work was refused: pre-existing quota semantics, `markAnthropicUsedUnlessNoWork`).
- Header wording in `renderSemaphore.ts` (five unbounded renders exhaust a pool of 10) and in `aiRoutesFetchTimeout.test.ts`; `.claude.md` R-188 entry records the final rule. Evidence r6: `red.r6.unit.log` (5/56 red), `green.r6.unit.log` 269/269 at `b96b45c4e`, `mutations.r6.log` M30-M36 killed (M32 survived at first: no refused value above the default was tested; `5.5` and `50.0` added), `regression.r6.unit.log` 1750/1750.

Evidence r7 (queue-timeout follow-up): `red.r7.unit.log` (6/40 red), `green.r7.unit.log` 316/316 at `c7d707d71`, `mutations.r7.log` M37-M39 killed.

Evidence r8: admission and `renderQueueBound` read the count through one `maxConcurrent()` helper, and an admission-level test (`'1.0'` at pool 40: one active, one queued) pins it. `green.r8.unit.log` 299/299 at `0f75f64cd`, `mutations.r8.log` M40-M41 killed. No red run: the refactor changes no behaviour, so the test passes on the old code too.

Evidence r9: the invalid-value warning says "falling back" (the `using` field says to what), not "nearest allowed value". `red.r9.unit.log`, `green.r9.unit.log` 41/41 at `75324f2fe`, `mutations.r9.log` M42 killed, wider regression `regression.r9.unit.log` 1751/1751 at the same sha.

## PR #630 review fixes
- Post-deploy signal (new `src/lib/auth/poolTelemetry.ts`, `connectObserved`, used at the connect sites of authPool, bearerPipeline, extensionToken and the platform-admin app pool): warn `auth pool saturated: an acquire had to queue` with `{pool, waitingCount, totalCount, idleCount, max}` when `waitingCount > 0` at acquire time, at most once per 10 s per pool; error `auth pool acquire failed` naming the pool when an acquire fails (the 15 s connection timeout). Watch for the warning after deploy; sustained occurrences mean 10 is too small: set `AUTH_POOL_MAX=20` (plain digits) and restart. The four wiring edits are not individually tested (the helper is); the existing withAuth/bearer/extension suites still pass through it. The platform-admin ADMIN pool is not observed.
- Concurrency count: refused spellings now give `min(default, max(1, floor(n)))` as master's floor did (`0.5`, `1.0`, `1.9` -> 1; `2.5` -> 2); the timeout keeps default-on-refused. ceil was the unsafe direction.
- `noteAiService`: AbortController + setTimeout cleared in `finally` (AbortSignal.timeout cannot be cleared); tests for the abort at 60 s and no timer left.
- The env-parsing tests moved to `renderSemaphoreEnv.test.ts` (202 lines; `renderSemaphore.test.ts` 294).
- Evidence r10: `red.r10.unit.log`, `green.r10.unit.log` 52/52 at `17cb49ffb`, `mutations.r10.log` M43-M49 killed, `regression.r10.unit.log` 1756/1756 (the first regression run caught the helper crashing on test pool mocks without `options`; fixed). The red run covered the floor rule, the note call and the missing telemetry module (3 tests plus a failed import); the telemetry tests were written with the module, so their red is the mutants.

## Remaining long pool holders under withAuth
- **Confirmed risk, not changed:** `statement-bulk-email.ts` is `withAuth(withErrorHandler(withCsrf(withWriteAccess(...))))`, called from `useStatementEmail.ts`, and sends up to 100 emails sequentially inside one request transaction (one pool connection idle in transaction for the whole loop). Follow-up: move the sends to `runAfterCommit`.
- Server `fetch(` with no signal or timeout, found by grep and NOT individually verified to run under withAuth: `llmCategorizationPass.ts`, `sentMirrorService.ts`, `sageAutoImportService.ts`, `signumIntegrationService.ts`, `weasyprintService.ts`, `twilioMediaFetch.ts`, `sarsEfilingClient.ts`, `vfStorageAdapter.ts`, `imapMirrorService.ts`.
- `cash-flow-forecast.ts` has no `checkAiRateLimit`, and concurrent cache misses are not de-duplicated (each miss makes its own provider call). Not changed.

Not changed: pool `waitingCount` / `totalCount` is not logged anywhere. It is the signal to watch
after deploy (a sustained non-zero `waitingCount` on authPool means the default of 10 is too small;
the rollback is `AUTH_POOL_MAX=20` in the prod env and a restart).
