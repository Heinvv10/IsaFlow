# K-139 — supplier list cache key omits the page size

**Claim.** "Supplier list cache key omits limit. A limit=200 request can be served the cached 25-row
response."

**Disposition: confirmed** (exactly as claimed).

**Evidence.**
- `pages/api/accounting/suppliers-list.ts:60-68` (origin/master) caches the first unfiltered page
  under `CACHE_KEYS.suppliers(companyId)`; `src/lib/cache-keys.ts:20` is
  `` `${companyId}:suppliers` `` — no page size, no offset.
- The route accepts `?limit=` up to 200 (line 47) and the entry lives `CACHE_TTL.REFERENCE_DATA`
  (5 minutes, cache-keys.ts:9).
- RED: `tests/integration/k139-supplier-cache-key-omits-limit.int.test.ts` — 1 failed of 1. With 30
  suppliers, a `limit=25` call warms the cache and the following `limit=200` call is answered with
  25 rows while `total` correctly reports 30. Log: `red.log`.

**Reachability.** Whichever page size asks first wins for the whole company for 5 minutes. The
supplier picker and the supplier table request different sizes from the same page, so the order is
decided by render timing.

**Proposed minimal fix.** Put the page size in the key — `CACHE_KEYS.suppliers(companyId, limit)`
returning `` `${companyId}:suppliers:${limit}` `` — and keep `cache.invalidate` working by
switching the POST-side invalidation to a prefix sweep, or simply cache only the default 25 and
bypass the cache for any other limit (two lines, no key change, no invalidation change).
Check `customers` for the same shape before choosing.

**Historical-data impact.** None — read-path caching only, nothing is written. The visible symptom
is a picker that silently omits suppliers, so users may have created duplicates rather than
selecting an existing supplier; that is worth a duplicate-name check, not a data fix.

**Risks.** A prefix-based invalidation must cover every key variant or a stale list survives a
create. The bypass option avoids that entirely.
