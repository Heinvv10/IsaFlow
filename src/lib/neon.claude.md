# neon.ts

## Purpose
`pg.Pool`-backed tagged-template SQL client — the canonical DB entry point for the whole app. Preserves the public surface of the former Neon driver while running against vanilla Postgres (self-hosted Supabase via Supavisor on `:6543`). The legacy filename is kept so existing `@/lib/neon` imports across 300+ call sites don't need changing.

`neon.ts` is a barrel (R-184); the code is in `src/lib/neon/`. Which module holds what, and which owns each piece of state, is in `src/lib/neon/.claude.md`.

## Key exports
- `type DbRow = Record<string, any>`
- `const sql: SqlFunction` — tagged template (`` sql`SELECT ...` ``) returning a `LazyQuery<T>` which is awaitable as `T[]`
  - `sql.transaction(queries | (tx) => queries, options?)` — array- or callback-form batched transaction; `options.isolationLevel` supported
  - `sql.unsafe<T>(text, values?)` — raw SQL fragment; interpolatable into another `` sql`...` `` or awaitable alone
  - `sql.query<T>(text, values?)` — alias for `unsafe`
- `transaction(queriesFn)` — callback form with `ReadCommitted` default isolation (back-compat helper)
- `withTransaction<T>(fn: (tx: TxSql) => Promise<T>)` — sequential-imperative transaction helper; full BEGIN/COMMIT/ROLLBACK
- `withSavepoint<T>(name, fn)` — runs inside a SAVEPOINT on the request-scoped ALS transaction so one failed query doesn't poison the whole request tx; degrades to plain `fn()` when no outer tx
- `fmtDate(val: unknown): string` — formats a DB date column as `YYYY-MM-DD` robust to Date/string
- `type TxSql`
- default export: `sql`

## Dependencies
- `pg` — node-postgres Pool
- `@/lib/als` (static import) — AsyncLocalStorage for request-scoped tx client; enables RLS GUC persistence inside `withAuth`
- `@/lib/logger`

## Critical notes
- **Import `@/lib/neon` only — never `@/lib/neon/<module>`.** Tests `vi.mock('@/lib/neon', factory)` with partial factories; a module that imported `src/lib/neon/sql.ts` directly would get the real `sql` under those tests. Only the barrel and its sibling modules may import the modules (`tests/unit/lib/neonModuleShape.test.ts`).
- **NEVER string-concat SQL**. Always use the tagged template: `` sql`SELECT ... WHERE id = ${id}` ``. Values become `$N` parameters automatically; `LazyQuery` values spliced in are renumbered so nested `` sql`...` `` fragments compose safely.
- **Multi-tenant**: every query must include `company_id = ${companyId}` or route through an RLS-aware policy. RLS is enforced via `set_config('request.jwt.claims', $claims, true)` inside the request tx; `withAuth` applies this before the handler runs. A missing `company_id = $X` predicate is an IDOR — the pentest skill greps for this.
- **ALS-aware**: if an outer `withAuth` transaction is in progress (ALS store has a `client`), `sql` awaited outside a savepoint runs ON that transaction client, so RLS GUCs are honoured. If you bypass `sql` and use your own pool, RLS sees no claims.
- **withSavepoint**: inside a `withAuth` request, a single failed query poisons the whole request tx ("current transaction is aborted …"). Wrap defensive reads in `withSavepoint('name', async () => { ... })` so a savepoint rollback keeps the outer tx alive. Savepoint name must match `/^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/`.
- **Date handling**: `row.some_date` can be `Date` or `string` depending on the column type (`date` → Date via pg, `timestamptz` → Date). Callers normalise via `fmtDate()` or `String(row.col).slice(0, 10)`.
- **`any` in DbRow**: kept to match the old Neon shape so `row.status` type-checks without casting. Prefer explicit casts at the mapping boundary (`String(row.status) as Loan['status']`). Tighten per-row by parameterising `sql<Row>\`...\``.
- **SSL**: `DATABASE_SSL=strict` enforces CA verification; `disable` turns SSL off; default is `{ rejectUnauthorized: false }` for self-hosted Supabase's self-signed cert.
- **Login role (S-07b)**: the pool reads `serviceDatabaseUrl()` (`@/lib/serviceDatabaseUrl`, shared with the rate-limit pool): `SERVICE_DATABASE_URL`, falling back to `DATABASE_URL`. In production that is `isaflow_service` (migration 915): it inherits `app_service` (app_user's grants, a row-admitting policy per command an app_user policy admits, `users.email`), owns nothing, has no BYPASSRLS. Anything that needs the owner (DDL, REFRESH MATERIALIZED VIEW) goes through a SECURITY DEFINER function that takes no steering input, as `refresh_customer_invoice_view_summary()` does. A new RLS table gets its `app_service_<cmd>` policies from `public.app_service_sync_policies()`, which every migration run calls; a new app_user predicate that is not a forgeable claim must be reviewed into `s07b-app-pool-login-role.policies.int.test.ts`.
- **Pool lifetime**: Singleton — `_pool` is lazily created on first `getPool()` call and reused. `PG_POOL_MAX` env (default 10) controls size; read through `poolSizeFromEnv` (`@/lib/limits/poolLimits`), so only a whole number 2-100 is honoured (a `1` is raised to 2, because `withTransaction` outside a request holds one connection and a bare `sql` in its callback needs a second; a floor, not a safe size). Anything else gives `min(default, ceil(Number(text)))` when `Number(text)` is finite and above 0, else `min(default, 10)`, never below 2, with one warning (R-182). Do not call `pool.end()` from app code.
- **File is `neon.ts` but is NOT Neon**: don't trust the name. `@neondatabase/serverless` is not on the hot path anymore.
- `sql.transaction` array-form queries execute sequentially inside one BEGIN; callback-form receives a `tx`-bound `SqlFunction` so you can build the list from earlier row data.

## Recent changes
- 2026-10-22 (S-07b): the pool logs in from `SERVICE_DATABASE_URL` (falls back to `DATABASE_URL`).
- 2026-10-03 (R-184): split the 475-line `neon.ts` into a barrel over `src/lib/neon/{pool,query,sql,transaction}.ts`. Declarations moved byte-identical; same export names and types (`docs/audits/remediation/R-184/`).
- 2026-10-02 (R-182): `PG_POOL_MAX` is read through `poolSizeFromEnv` with a floor of 2 (`MIN_PG_POOL_MAX`): outside a request `withTransaction` holds one connection and a bare `sql` in its callback takes a second, so a pool of 1 timed out. A refused spelling gives the size it meant, never more than 10.
- 2026-04-24: Supabase-cutover drift fixes; duplicate-prefix/ghost-row tracking hardening.
- 2026-04-18: ALS-aware routing — bare `sql` inside `withAuth` now uses the request tx client so RLS GUCs are honoured; pg.Pool driver replaced Neon serverless.
