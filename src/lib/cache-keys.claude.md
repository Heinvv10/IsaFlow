# `src/lib/cache-keys.ts`

## Purpose
Centralised TTL constants and `companyId`-prefixed cache key generators — prevents key collisions and enforces tenant isolation in `cache.ts`.

## Key exports

- `CACHE_TTL` — object of TTL constants (ms):
  - `REPORT_RESULTS` — 2 min (report query results)
  - `PERMISSIONS` — 10 min (user permissions)
  - `SETTINGS` — 15 min (company settings)

- `CACHE_KEYS` — key generator functions, all scoped to `companyId`:
  - `items(companyId)` → `"<id>:items"`
  - `report(companyId, type, paramsHash)` → `"<id>:report:<type>:<hash>"`
  - `permissions(companyId, userId)` → `"<id>:perms:<userId>"`
  - `settings(companyId)` → `"<id>:settings"`

## Dependencies
None.

## Critical notes
- **Reference lists are not cached.** The supplier list (K-139), the customer list and the chart of accounts (R-125) read the database every time. Each table has 10+ writer files (routes, MCP tools, merges, soft-delete, imports), no invalidation list stayed complete, and an in-process cache is invisible to other processes. The chart of accounts also carries `has_transactions`, which every journal post changes. Measured cost: ~10 ms at 3 000 accounts / 500 000 journal lines; ~2.5 ms for 5 000 customers. Don't reintroduce a cache for a table unless every writer shares one service that invalidates it.
- **Always use these generators** — never construct cache keys by hand in services; manual strings break `invalidatePrefix`/`invalidateCompany` if the prefix format drifts.
- **`companyId` prefix is the tenant boundary**: `cache.invalidateCompany(companyId)` relies on all keys starting with `${companyId}:`. Any key not following this pattern will NOT be invalidated by `invalidateCompany`.
- **`report` key requires a stable `paramsHash`**: generate with a deterministic hash of the query parameters (e.g. `JSON.stringify(sortedParams)`) — unstable serialisation = cache misses.
- Add new key generators here rather than hardcoding strings in services or API handlers.
