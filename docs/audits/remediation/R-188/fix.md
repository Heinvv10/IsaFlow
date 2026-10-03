# R-188: DEFAULT_AUTH_POOL_MAX 20 -> 10

## Defect
`AUTH_POOL_MAX` sizes four pools (authPool, withExtensionToken, bearerPipeline, platform-admin
app pool). At the default of 20 that is 80 connections per process against a shared Postgres
`max_connections` of 100. Golden Paths hit "remaining connection slots are reserved" on
2026-10-02. R-182's fix.md (connection budget) advised a lower default.

## Decision
Hein, 2026-10-03 (goal file `.claude/handoffs/2026-10-03-r183-r187-pool-budget-goal.md`): default 10.

## Fix
`DEFAULT_AUTH_POOL_MAX = 10` in `src/lib/limits/poolLimits.ts`. Nothing else in code changes;
every reader goes through `authPoolMax()`.

## Behaviour changes (verified from code and tests)
- Four AUTH pools: 80 -> 40 connections per process. Per-process total of every pool at the
  defaults: 117 -> 77 (10 neon + 40 auth + 10 admin + 10 rate-limit + 5 invite + 2 accept).
  R-182/fix.md's budget table is historical and left as written.
- `renderSemaphore` ceiling is `floor(authPoolMax() / 4)` (renderSemaphore.ts:92): 5 -> 2 at the
  default. Its own default of 3 renders is therefore clamped to 2, with a one-time warning.
  Operators who want 3 renders need `AUTH_POOL_MAX` >= 12 or `PDF_MAX_CONCURRENT_RENDERS=2`
  to silence the warning.
- `poolSizeFromEnv` (unchanged code), `AUTH_POOL_MAX` outcomes:
  - unset/blank: 10 (was 20).
  - plain digits 2-100 (incl. 11-100): as given, unchanged, silent.
  - refused spelling with a finite positive value: `min(10, ceil(value))`. `15.0`, `20.0`, `+20`,
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

## Not measured
p99 before/after was NOT measured. The only load harness in the repo is
`scripts/audit-2026-04-14/perf-autocannon.sh`; it needs a running app on :3200 and an admin token
file at `/tmp/isaflow-admin-token.env`, neither available here, and the effect (slot exhaustion on
a shared Postgres) is not reproducible against an isolated fixture. Risk to watch after deploy:
a pool of 10 per wrapper means a burst of more than 10 concurrent authed requests on one wrapper
queues for up to the 15 s acquire timeout instead of up to 20.
