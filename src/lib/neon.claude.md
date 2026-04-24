# neon.ts

## Purpose
`pg.Pool`-backed tagged-template SQL client — the canonical DB entry point for the whole app. Preserves the public surface of the former Neon driver while running against vanilla Postgres (self-hosted Supabase via Supavisor on `:6543`). The legacy filename is kept so existing `@/lib/neon` imports across 300+ call sites don't need changing.

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
- `@/lib/als` (lazy-imported) — AsyncLocalStorage for request-scoped tx client; enables RLS GUC persistence inside `withAuth`
- `@/lib/logger`

## Critical notes
- **NEVER string-concat SQL**. Always use the tagged template: `` sql`SELECT ... WHERE id = ${id}` ``. Values become `$N` parameters automatically; `LazyQuery` values spliced in are renumbered so nested `` sql`...` `` fragments compose safely.
- **Multi-tenant**: every query must include `company_id = ${companyId}` or route through an RLS-aware policy. RLS is enforced via `set_config('request.jwt.claims', $claims, true)` inside the request tx; `withAuth` applies this before the handler runs. A missing `company_id = $X` predicate is an IDOR — the pentest skill greps for this.
- **ALS-aware**: if an outer `withAuth` transaction is in progress (ALS store has a `client`), `sql` awaited outside a savepoint runs ON that transaction client, so RLS GUCs are honoured. If you bypass `sql` and use your own pool, RLS sees no claims.
- **withSavepoint**: inside a `withAuth` request, a single failed query poisons the whole request tx ("current transaction is aborted …"). Wrap defensive reads in `withSavepoint('name', async () => { ... })` so a savepoint rollback keeps the outer tx alive. Savepoint name must match `/^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/`.
- **Date handling**: `row.some_date` can be `Date` or `string` depending on the column type (`date` → Date via pg, `timestamptz` → Date). Callers normalise via `fmtDate()` or `String(row.col).slice(0, 10)`.
- **`any` in DbRow**: kept to match the old Neon shape so `row.status` type-checks without casting. Prefer explicit casts at the mapping boundary (`String(row.status) as Loan['status']`). Tighten per-row by parameterising `sql<Row>\`...\``.
- **SSL**: `DATABASE_SSL=strict` enforces CA verification; `disable` turns SSL off; default is `{ rejectUnauthorized: false }` for self-hosted Supabase's self-signed cert.
- **Pool lifetime**: Singleton — `_pool` is lazily created on first `getPool()` call and reused. `PG_POOL_MAX` env (default 10) controls size. Do not call `pool.end()` from app code.
- **File is `neon.ts` but is NOT Neon**: don't trust the name. `@neondatabase/serverless` is not on the hot path anymore.
- `sql.transaction` array-form queries execute sequentially inside one BEGIN; callback-form receives a `tx`-bound `SqlFunction` so you can build the list from earlier row data.

## Recent changes
- 2026-04-24: Supabase-cutover drift fixes; duplicate-prefix/ghost-row tracking hardening.
- 2026-04-18: ALS-aware routing — bare `sql` inside `withAuth` now uses the request tx client so RLS GUCs are honoured; pg.Pool driver replaced Neon serverless.
