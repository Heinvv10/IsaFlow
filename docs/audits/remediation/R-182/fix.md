# R-182: pool sizes read without validation

## Defect
`PG_POOL_MAX`, `AUTH_POOL_MAX` and `PLATFORM_ADMIN_POOL_MAX` were read with a plain
`Number(process.env.X ?? default)`. Corrected in review round 1: with the installed
pg-pool 3.13.0 (`index.js:89`, `max = max || poolSize || 10`) NaN and 0 already became 10,
so a typo was not unbounded. The real dangers were a huge or Infinity value (no practical
limit) and a negative one (truthy, so the pool is always "full" and every acquire waits out
its timeout). Pinned against the real library, reached through `pg`, in `tests/unit/lib/pgPoolMaxPremise.test.ts`.
The shared Postgres (`max_connections` 100) serves prod, dev, CI and Supabase services.
`RATE_LIMIT_POOL_MAX` (R-175) already validated.

## Fix
`poolSizeFromEnv(name, default, category = 'pool', minimum = 1)` in `src/lib/limits/poolLimits.ts`:
plain decimal digits, a whole number from the floor to 100 is used as given (the floor is 2 for
`PG_POOL_MAX` and `AUTH_POOL_MAX`, 1 for the others). Unset or blank is the default, silently.
Anything else is refused with one warning per (name, value) and gives
`min(default, 10, ceil(Number(text)))` when `Number(text)` is finite and above 0, else
`min(default, 10)`. So `5.0`, `+5` and `0x5` give 5, `2.5` gives 3 (pg-pool opened ceil(max)),
`1e1` gives 10 (so `50.0` gives 10 while `50` gives 50: only ever lower, and warned); NaN and 0 give 10 as pg-pool did; negative and Infinity (broken before) give
`min(default, 10)`. No spelling the old `Number()` accepted gives more connections than
pg-pool allowed for it. The warning logs the name, the value's length and a digits-only flag,
never the text (a pool variable can hold a pasted DSN). The old rate-limit reader accepted
`1e1`, `10.0` and `+5` as given; they now go through this rule. The rate-limit warning stays under its `rateLimit` category.
`authPoolMax()` is now validated and every pool reads through it or the reader:

| Site | Variable | Default |
|---|---|---|
| `src/lib/neon.ts` getPool | PG_POOL_MAX | 10 |
| `src/lib/auth/authPool.ts` (via authPoolMax) | AUTH_POOL_MAX | 20 |
| `src/lib/auth/withExtensionToken.ts` (was inline) | AUTH_POOL_MAX | 20 |
| `src/lib/auth/bearerPipeline.ts` (was inline) | AUTH_POOL_MAX | 20 |
| `src/lib/auth/withPlatformAdmin.pools.ts` getAppPool (was inline) | AUTH_POOL_MAX | 20 |
| `src/lib/auth/withPlatformAdmin.pools.ts` getPlatformAdminPool | PLATFORM_ADMIN_POOL_MAX | 10 |
| `src/lib/rateLimitPool.ts` (its own validator removed) | RATE_LIMIT_POOL_MAX | 10 |

Not changed: `withInviteToken.ts` (max 5), `pages/api/invitations/[token]/accept.ts` (2),
`pages/api/auth/verify-email.ts` (2) and `scripts/_pg.ts` (5) use a literal `max`, not
the environment. Other scripts build pools with no `max` (pg default 10), also not from
the environment. Defaults are unchanged for unset and valid values.

## Connection budget (measured from code, one app process, defaults)
| Pool | Max | Lifetime |
|---|---|---|
| neon `getPool` | 10 | per process, lazy |
| authPool (withAuth) | 20 | per process, lazy |
| withExtensionToken | 20 | per process, lazy |
| bearerPipeline | 20 | per process, lazy |
| withPlatformAdmin app pool | 20 | per process, lazy |
| withPlatformAdmin admin pool | 10 | per process, lazy |
| rate-limit pool | 10 | per process, lazy |
| withInviteToken | 5 | per process, lazy |
| invitation accept admin pool | 2 | per process, lazy |
| verify-email admin pool | 2 | per request, ended by the request |
| `pg.Client` impersonation write | 1 | per call |

The cap of 100 is per variable, not per process: `AUTH_POOL_MAX` sizes four pools, so 100
would be 400 connections in one process. AUTH_POOL_MAX advice: its default of 20 is 80
connections per process and 100 would be 400, so with max_connections 100 shared with dev, CI
and Supabase, set it no higher than the default and lower it (10 gives 40) if connections run
short. Its floor is 2 (see Review round 3), and so is PG_POOL_MAX's (Review round 4). A floor of 2 is
what makes one PDF render, or one nested `sql` inside `withTransaction`, possible at all; it is
not a safe size, since a pool of 2 can still be taken by a concurrent request.

Sum of the per-process pools: **117**, plus 2 per in-flight verify-email request and 1 per
impersonation write. That exceeds `max_connections` 100 on its own, before dev, CI and
Supabase services. Pools are lazy and idle connections close after 30 s, so a process
reaches 117 only if every route family is hit at once under load; the ceiling is still
what the budget has to survive. The four AUTH_POOL_MAX pools (authPool, extension, bearer,
app) alone are 80 (one variable).

## Tests
- `tests/unit/lib/poolSizeFromEnv.test.ts`: unset, blank, valid, 0, negative, fractional, >100,
  text, NaN/Infinity, hex/binary/octal/exponent, `10.0`, sign, non-ASCII digit; the
  `min(default, 10, ceil(Number(text)))` rule; one warning per (name, value); a pasted URL never
  reaches the log (name, length and digits-only flag only; there is no truncation); category;
  the floor and its clamp; `authPoolMax`.
- `tests/unit/lib/poolSizesBuilt.test.ts`: pg.Pool mocked; each of 7 sites is built with the
  validated size (valid, unset, 9 bad spellings under the `ceil(n)` rule, and 3 spellings below
  the floor of 2 for the AUTH_POOL_MAX and PG_POOL_MAX sites).
- `tests/unit/lib/pgPoolMaxPremise.test.ts`: the REAL pg-pool: NaN/0 give 10, negative never
  opens a connection, Infinity is kept, a fractional 2.5 allows three connections (ceil).
- `tests/unit/lib/rateLimitPoolMax.test.ts` (R-175, header reworded, `rateLimit` category asserted).
- `tests/unit/lib/pdf/renderSemaphore.test.ts`: invalid AUTH_POOL_MAX gives ceiling 2; a pool of 1
  (`1`, `1.0`, `0.5`) is raised to 2, ceiling 1.
- `tests/unit/lib/neonPoolNestedSql.test.ts`: real pg-pool, fake client: a size-1 pool times out on a
  nested `sql` inside `withTransaction`; PG_POOL_MAX `1`, `1.0`, `0.5` is raised to 2 and the nested
  `sql` completes using two connections.
- Evidence by round: round 0 red `red.unit.log` (68 failed of 105 across 3 files, before the fix)
  and `green.log` (116 passed, 4 files). Green logs with the exact commands: `green.round1.log`
  (127), `green.round2.log` (149), `green.round3.log` (178), `green.round4.log` (184 passed in the
  6 files above; the final file set). Mutants, each with its clean baseline read first, are in
  `mutations.log`: 13 in round 0, 7 in round 1, 7 in round 2, 4 in round 3, 4 in round 4; all red.
  Rounds 5 and later changed docs and test names only; the shuffle check is in Review round 5.

## Review round 1
1. Rationale corrected everywhere (see Defect); premise pinned by a real-library test.
2. Invalid value gives `min(default, 10)`, not the default: no pool gets bigger than before.
   PDF render ceiling: invalid AUTH_POOL_MAX now gives a pool of 10 and ceiling floor(10/4) = 2.
   Before it was 3 (the semaphore's NaN/<=0 guard returned its own default while the real pool
   was 10 via pg-pool). 2 matches the pool that actually exists; if 3 is wanted it needs a
   decision. A valid value is unchanged. The guard at `renderSemaphore.ts:93` is unreachable
   now (the reader returns 1-100 always) and was removed.
3. One warning per (name, value). (Truncation of the logged value was replaced in round 2 by
   logging length and digits-only only.)
4. Per-variable cap documented in the reader, the budget section and `rateLimit.claude.md`.
5. Rate-limit warning keeps the `rateLimit` category; the newly refused spellings are noted above.
6. Evidence reconciled as listed under Tests.

## Review round 2
1. A refused spelling the old `Number()` read as usable gives at most ceil of that size
   (`5.0`, `+5`, `0x5` give 5; `2.5` gives 3; tested at the reader, at every pool site and at the
   rate-limit pool; `0.5` gives 1). The claim in `poolLimits.ts`, the test headers and this file is
   the one sentence above.
2. The warning no longer logs the value: name, length and digits-only only. A test feeds a URL
   with a password and asserts neither the password nor the user name is in the log.
3. `pgPoolMaxPremise.test.ts` reaches pg-pool through `pg` (`new pg.Pool`), the copy the app uses,
   and now also pins that a fractional max opens ceil(max) connections.
4. The warned set: every warning case in `poolSizeFromEnv.test.ts` uses a value unique for its
   name, with a header comment saying why; `poolSizesBuilt.test.ts` resets modules per test.
5. One AUTH_POOL_MAX advice sentence, the same in `poolLimits.ts`, `rateLimit.claude.md` and
   this file; `poolLimits.ts` header reflowed in round 1.
Evidence: `green.round2.log` (exact commands; 149 passed in 5 files; wider suite 1859 passed,
6 skipped) and 7 round-2 mutants in `mutations.log`, baseline 149 passed first, all red.

## Review round 3
1. Stale statements of the rule (`neon.claude.md`, `rateLimit.claude.md`, `rateLimitPool.ts`, the
   `rateLimitPoolMax.test.ts` header) now state it once, the same way: `min(default, 10,
   ceil(Number(text)))` when `Number(text)` is finite and above 0, else `min(default, 10)`.
   (The lead's draft said "at least 1"; the code and tests use "above 0", so `0.5` gives 1.)
   `50.0` gives 10 while `50` gives 50: only ever lower, and warned. Budget paragraph unspliced.
2. `AUTH_POOL_MAX` has a minimum of 2 (`MIN_AUTH_POOL_MAX`): a PDF render holds one connection and
   the browser re-enters the API for a second from the same pools, so a pool of 1 made every
   export wait out the acquire timeout. `1`, `1.0`, `0.5` are raised to 2 with the warning.
   The render ceiling is `max(1, floor(2/4))` = 1, so it stays at least 1 and correct.
   Tested at the reader, `authPoolMax`, every AUTH_POOL_MAX pool site and the semaphore.

## Review round 4
1. `minimum` is held to `min(minimum, default, 10)` inside the reader, so a floor can never make a
   refused value give a pool bigger than the default or 10 (tested with a floor of 50).
2. PG_POOL_MAX: a path that needs two neon-pool connections exists. Outside a request,
   `withTransaction` (`neon.ts`, the `pool.connect()` branch) holds one connection; a bare `sql`
   in its callback has no ALS client and runs on `getPool().query`, a second connection from the
   same pool. `payrollBulkEmployeeService.ts:168-174` records this as a known edge (unreachable
   from its one caller today, which is inside `withAuth`). Proved in
   `tests/unit/lib/neonPoolNestedSql.test.ts` (real pg-pool, fake client): a size-1 pool times out
   on the second acquire while the first is held; with PG_POOL_MAX 1, `1.0` or `0.5` the pool is
   raised to 2 and the nested `sql` completes using two connections. So PG_POOL_MAX has a floor
   of 2 (`MIN_PG_POOL_MAX`). No in-repo caller was shown to hit it today; the floor removes a
   deadlock that one new caller could create.
3. Wording: a floor of 2 is the minimum that makes one PDF render or one nested `sql` possible,
   not a safe size (see the budget section).
4. JSDoc wraps at `poolLimits.ts` reflowed.
Evidence: `green.round4.log` (184 passed in 6 files), `mutations.log` round 4.

## Review round 5 (blind review of PR #617)
1. `poolSizeFromEnv.test.ts`: the repeated (name, value) pairs now use `_B` and `_C` names; the
   header says so. The file was run with `--sequence.shuffle` under seeds 1, 7, 42, 1234 and 99999: 45 passed each time.
2. This file brought to round-4 behaviour: signature with `minimum`, floor 2 for PG/AUTH,
   truncation text removed, `poolSizesBuilt` description.
3. AUTH_POOL_MAX facts (floor of 2, four-pool multiplier, advice) moved to `src/lib/auth/.claude.md`;
   `rateLimit.claude.md` keeps only RATE_LIMIT_POOL_MAX's rule. Mirrors regenerated.
4. `src/lib/neon.ts` is 475 lines (474 before this change), over the 300-line limit; the oversize
   is older than R-182 and is registered as R-184 (checked free: no R-184 in backlog.json, git log or any branch; R-183 is taken on another branch) rather than fixed here.
