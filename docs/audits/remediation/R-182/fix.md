# R-182: pool sizes read without validation

## Defect
`PG_POOL_MAX`, `AUTH_POOL_MAX` and `PLATFORM_ADMIN_POOL_MAX` were read with a plain
`Number(process.env.X ?? default)`. A non-numeric value is NaN, and pg treats a NaN
`max` as no limit, so a typo made a pool unbounded on a Postgres shared by prod, dev,
CI and Supabase services (`max_connections` 100). `RATE_LIMIT_POOL_MAX` (R-175) already
validated.

## Fix
`poolSizeFromEnv(name, default)` in `src/lib/limits/poolLimits.ts`: plain decimal digits,
whole number 1-100, else the default with one `log.warn`. Unset or blank is the default,
silently. Hex, exponent, sign, fraction and non-ASCII digits are refused (`0x10`, `1e1`).
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
the environment. Defaults are unchanged.

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

Sum of the per-process pools: **117**, plus 2 per in-flight verify-email request and 1 per
impersonation write. That exceeds `max_connections` 100 on its own, before dev, CI and
Supabase services. Pools are lazy and idle connections close after 30 s, so a process
reaches 117 only if every route family is hit at once under load; the ceiling is still
what the budget has to survive. The four AUTH_POOL_MAX pools (authPool, extension, bearer,
app) alone are 80.

## Tests
- `tests/unit/lib/poolSizeFromEnv.test.ts`: unset, blank, valid, 0, negative, fractional,
  >100, text, NaN/Infinity, hex/binary/octal/exponent, sign, non-ASCII digit; `authPoolMax`.
- `tests/unit/lib/poolSizesBuilt.test.ts`: pg.Pool mocked; each of 7 sites is built with the
  validated size (valid, unset, 7 bad spellings).
- `tests/unit/lib/rateLimitPoolMax.test.ts` (R-175) still passes unchanged.
- Red on unchanged code: `red.unit.log` (68 failed). Green: `green.log`. Mutants: `mutations.log`.
