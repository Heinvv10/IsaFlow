# R-182: pool sizes read without validation

## Defect
`PG_POOL_MAX`, `AUTH_POOL_MAX` and `PLATFORM_ADMIN_POOL_MAX` were read with a plain
`Number(process.env.X ?? default)`. Corrected in review round 1: with the installed
pg-pool 3.13.0 (`index.js:89`, `max = max || poolSize || 10`) NaN and 0 already became 10,
so a typo was not unbounded. The real dangers were a huge or Infinity value (no practical
limit) and a negative one (truthy, so the pool is always "full" and every acquire waits out
its timeout). Pinned against the real library in `tests/unit/lib/pgPoolMaxPremise.test.ts`.
The shared Postgres (`max_connections` 100) serves prod, dev, CI and Supabase services.
`RATE_LIMIT_POOL_MAX` (R-175) already validated.

## Fix
`poolSizeFromEnv(name, default, category = 'pool')` in `src/lib/limits/poolLimits.ts`: plain
decimal digits, whole number 1-100 is used as given. Unset or blank is the default, silently.
Anything else gives `min(default, 10)` (what pg-pool made of NaN/0, so a typo never makes a
pool bigger than before) with one warning per (name, value), value truncated to 40 chars.
Refused spellings include `0x10`, `1e1`, `10.0` and `+5` (the old rate-limit reader accepted
those; now they fall back). The rate-limit warning stays under its `rateLimit` category.
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
would be 400 connections in one process. With `max_connections` 100 shared with dev, CI and
Supabase, an operator should leave it at the default or set it to 10 or less; the budget is
already over at defaults.

Sum of the per-process pools: **117**, plus 2 per in-flight verify-email request and 1 per
impersonation write. That exceeds `max_connections` 100 on its own, before dev, CI and
Supabase services. Pools are lazy and idle connections close after 30 s, so a process
reaches 117 only if every route family is hit at once under load; the ceiling is still
what the budget has to survive. The four AUTH_POOL_MAX pools (authPool, extension, bearer,
app) alone are 80 (one variable).

## Tests
- `tests/unit/lib/poolSizeFromEnv.test.ts`: unset, blank, valid, 0, negative, fractional, >100,
  text, NaN/Infinity, hex/binary/octal/exponent, `10.0`, sign, non-ASCII digit; `min(default, 10)`;
  one warning per (name, value); truncation; category; `authPoolMax`.
- `tests/unit/lib/poolSizesBuilt.test.ts`: pg.Pool mocked; each of 7 sites is built with the
  validated size (valid, unset, 7 bad spellings giving `min(default, 10)`).
- `tests/unit/lib/pgPoolMaxPremise.test.ts`: the REAL pg-pool: NaN/0 give 10, negative never
  opens a connection, Infinity is kept.
- `tests/unit/lib/rateLimitPoolMax.test.ts` (R-175, header reworded, `rateLimit` category asserted).
- `tests/unit/lib/pdf/renderSemaphore.test.ts`: invalid AUTH_POOL_MAX gives ceiling 2.
- Round 0: red `red.unit.log` (68 failed of 105 across 3 files, before the fix); green.log is
  the round-0 run (116 passed, 4 files). Round 1: `green.round1.log` (exact commands, 127 passed in
  5 files; wider suite 1837 passed, 6 skipped). Mutants: `mutations.log` (13 in round 0 against
  105 tests; 7 in round 1 against 127), all red, baselines first.

## Review round 1
1. Rationale corrected everywhere (see Defect); premise pinned by a real-library test.
2. Invalid value gives `min(default, 10)`, not the default: no pool gets bigger than before.
   PDF render ceiling: invalid AUTH_POOL_MAX now gives a pool of 10 and ceiling floor(10/4) = 2.
   Before it was 3 (the semaphore's NaN/<=0 guard returned its own default while the real pool
   was 10 via pg-pool). 2 matches the pool that actually exists; if 3 is wanted it needs a
   decision. A valid value is unchanged. The guard at `renderSemaphore.ts:93` is unreachable
   now (the reader returns 1-100 always) and was removed.
3. One warning per (name, value); long values truncated.
4. Per-variable cap documented in the reader, the budget section and `rateLimit.claude.md`.
5. Rate-limit warning keeps the `rateLimit` category; the newly refused spellings are noted above.
6. Evidence reconciled as listed under Tests.
