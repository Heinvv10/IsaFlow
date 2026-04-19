# `src/lib/als.ts`

## Purpose
AsyncLocalStorage store that carries per-request context (DB client, user ID, company ID, JWT claims) across the async call stack without prop-drilling.

## Key exports

- `als` — the `AsyncLocalStorage<RequestContext>` instance; used by middleware (`withAuth`, `withPlatformAdmin`) to set the store and by services/helpers to read it.
- `requireCtx() → RequestContext` — asserts the store is populated and returns it; throws a descriptive error if called outside a request context (e.g. in a background job or missing middleware).
- `RequestContext` — `{ client: PoolClient; userId: string; companyId?: string; claims: Record<string, unknown> }`.

## Dependencies
- `node:async_hooks` — `AsyncLocalStorage`
- `pg` — `PoolClient` type (the DB connection bound to this request's transaction)

## Critical notes
- **`companyId` is optional** — absent for platform-admin requests (`withPlatformAdmin`) which are not tenant-scoped. Service code that calls `requireCtx().companyId!` without a null check will throw on admin routes.
- **`client` is a checked-out pool connection** — bound to the current transaction. Never pass this client to a background job or setTimeout callback; it will be released when the request ends.
- **`requireCtx` throws on missing store** — this is intentional: a missing context means middleware wasn't applied. Fix the wrap order, don't catch the error.
- **Multi-tenant safety**: `companyId` flows from the JWT claims set by `withAuth`. Any service that reads `requireCtx().companyId` automatically gets the correct tenant without explicitly threading `company_id` through every function signature.
- **Do not call `als.run(...)` directly** in route handlers — let `withAuth` / `withPlatformAdmin` manage the store lifecycle.
