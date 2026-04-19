# `src/lib/cache-keys.ts`

## Purpose
Centralised TTL constants and `companyId`-prefixed cache key generators — prevents key collisions and enforces tenant isolation in `cache.ts`.

## Key exports

- `CACHE_TTL` — object of TTL constants (ms):
  - `REFERENCE_DATA` — 5 min (GL accounts, customers, suppliers, items)
  - `REPORT_RESULTS` — 2 min (report query results)
  - `PERMISSIONS` — 10 min (user permissions)
  - `SETTINGS` — 15 min (company settings)

- `CACHE_KEYS` — key generator functions, all scoped to `companyId`:
  - `glAccounts(companyId)` → `"<id>:gl-accounts"`
  - `glAccountsInactive(companyId)` → `"<id>:gl-accounts:all"` (includes inactive)
  - `customers(companyId)` → `"<id>:customers"`
  - `suppliers(companyId)` → `"<id>:suppliers"`
  - `items(companyId)` → `"<id>:items"`
  - `report(companyId, type, paramsHash)` → `"<id>:report:<type>:<hash>"`
  - `permissions(companyId, userId)` → `"<id>:perms:<userId>"`
  - `settings(companyId)` → `"<id>:settings"`

## Dependencies
None.

## Critical notes
- **Always use these generators** — never construct cache keys by hand in services; manual strings break `invalidatePrefix`/`invalidateCompany` if the prefix format drifts.
- **`companyId` prefix is the tenant boundary**: `cache.invalidateCompany(companyId)` relies on all keys starting with `${companyId}:`. Any key not following this pattern will NOT be invalidated by `invalidateCompany`.
- **`report` key requires a stable `paramsHash`**: generate with a deterministic hash of the query parameters (e.g. `JSON.stringify(sortedParams)`) — unstable serialisation = cache misses.
- Add new key generators here rather than hardcoding strings in services or API handlers.
