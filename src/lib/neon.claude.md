# DB client — `src/lib/neon.ts`

The project-wide Postgres client. Despite the filename, it is NOT the Neon serverless driver anymore — it's a `pg.Pool` wrapper against a vanilla Postgres instance (Supabase self-hosted over Supavisor at `:6543`). The legacy filename is preserved so existing `@/lib/neon` imports across 300+ call sites don't need changing.

## Exports

| Export | What |
|---|---|
| `sql` | Tagged template. `await sql\`SELECT * FROM loans WHERE id = ${id}\`` → `DbRow[]`. Placeholders bind as parameters — never concatenate. |
| `sql.transaction(queries[])` | Neon-style array form: batches multiple queries into one HTTP round-trip. |
| `sql.transaction(cb, opts?)` | Callback form: `cb(tx)` returns an array of queries to run in a tx. `opts.isolationLevel` supported. |
| `transaction(cb)` | Standalone re-export for call sites that never upgraded from the Neon shape. |
| `withTransaction(async (tx) => {…})` | Sequential helper — run imperative code inside a single tx. `tx` shadows `sql` so existing `sql\`…\`` calls just work. |
| `fmtDate(d)` | Normalises `Date | string` → `YYYY-MM-DD`. Needed because pg returns real `Date` objects. |
| `DbRow` | `Record<string, any>` — kept `any`-valued to match the old Neon driver shape; use `sql<MyRow>\`…\`` to tighten per-row. |

## Config
- `DATABASE_URL` required.
- `PG_POOL_MAX` (default 10) — pool size.
- `DATABASE_SSL=strict` enforces CA verification; default is self-signed acceptance (Supabase self-hosted uses a local cert).

## Multi-tenant contract
All app-level queries MUST scope by `company_id`. RLS is enforced at the DB layer via `set_config('request.jwt.claims', $claims, true)` inside the transaction; `withAuth` middleware applies this before the handler runs. A missing `company_id = $X` predicate is a bug; the RLS policy blocks cross-tenant reads but accurate error messages require the app-level filter too.

## Gotchas
- **Date handling**: `row.some_date` can be `Date` _or_ `string` depending on the column type (`date` → string, `timestamptz` → Date). Callers typically normalise with `String(row.col).slice(0, 10)` for `YYYY-MM-DD`.
- **`any` in DbRow**: The row type is `Record<string, any>` so `row.status` type-checks without casting. Prefer explicit casts at the mapping boundary (`String(row.status) as Loan['status']`).
- **Pool lifetime**: Singleton — `_pool` is lazily created on first `getPool()` call and reused. Do not call `pool.end()` from app code.
- **File is `neon.ts` but is NOT Neon**: Don't trust the name — `@neondatabase/serverless` isn't used anywhere on the hot path anymore (kept as devDep). All imports resolve to this `pg.Pool` shim.
