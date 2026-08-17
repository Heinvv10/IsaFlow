/**
 * Route → response-type registry.
 *
 * WHY THIS EXISTS
 * ---------------
 * `res.json()` returns `any`. Every call site that declared its own local
 * `interface` for a response was therefore having TypeScript *confirm its
 * guess* rather than check it — which shipped 13+ live production bugs
 * (admin "Login As" 100% broken, dashboard VAT permanently R0.00, 3 of 4
 * migration flows dead). See memory `project_api_envelope_defect_class`.
 *
 * A generic `apiJson<T>(url)` does NOT fix that: the caller still hand-writes
 * `T`, so the guess merely moves. The fix is to bind the type to the ROUTE, so
 * the caller cannot supply it at all.
 *
 * HOW TO USE
 * ----------
 * Register a route below, then call `apiJson('/api/…')` from `@/lib/apiFetch`.
 * The response type is INFERRED. A wrong field name is a compile error.
 *
 * Routes that are NOT registered resolve to `unknown`, which is unusable
 * without narrowing. That makes this registry self-ratcheting: adding a route
 * here is what makes it usable, so there is no baseline of exceptions to
 * maintain and no separate CI guard to keep in sync.
 *
 * TYPES COME FROM THE SERVICE, NOT FROM HERE.
 * Handlers are thin passthroughs (`apiResponse.success(res, await svc(...))`),
 * so `Awaited<ReturnType<typeof svc>>` is the true wire type and stays correct
 * when the service changes. NEVER hand-write a shape in this file — that would
 * reintroduce exactly the defect this registry exists to prevent.
 *
 * BUNDLE SAFETY: every import here MUST be `import type`. These modules are
 * server-side (they import `sql`); a value import would pull the database
 * client into the client bundle.
 */

import type { Currency } from '@/modules/accounting/services/core/currencyService';
import type { MigrationSession } from '@/modules/accounting/services/core/migrationService';
import type { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';

/**
 * Routes with a fixed path. Key = exact pathname (no query string — query
 * strings are handled by the matcher in `apiFetch.ts`).
 */
interface StaticRoutes {
  '/api/accounting/currencies': Currency[];
  '/api/accounting/migration/session': { session: MigrationSession | null };
  '/api/accounting/reports-vat-return': Awaited<ReturnType<typeof getVATReturn>>;
}

/**
 * Routes containing a dynamic segment, expressed as template-literal types.
 * A concrete URL like `/api/admin/users/abc-123/impersonate` structurally
 * extends the pattern, so inference still resolves.
 */
type DynamicRoutes = {
  [K in `/api/admin/users/${string}/impersonate`]: { redirect: string };
};

export type ApiRouteMap = StaticRoutes & DynamicRoutes;

export type KnownRoute = keyof ApiRouteMap;

/**
 * Resolve a concrete request URL to its registered route key.
 *
 * Tolerates a trailing query string or hash so callers can keep building URLs
 * with template literals. Resolves to `never` for unregistered routes, which
 * `apiJson` maps to `unknown`.
 */
export type RouteFor<U extends string> = {
  [K in KnownRoute]: U extends K | `${K}?${string}` | `${K}#${string}` ? K : never;
}[KnownRoute];

/**
 * The unwrapped `data` payload for a given request URL — or `unknown` when the
 * route is not registered.
 */
export type ResponseFor<U extends string> = [RouteFor<U>] extends [never]
  ? unknown
  : ApiRouteMap[RouteFor<U>];
