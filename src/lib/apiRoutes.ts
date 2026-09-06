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
import type { findVatAllocationMismatches } from '@/modules/accounting/services/reports/vatAllocationMismatchService';
import type { getPackTrend } from '@/modules/accounting/services/packs/packTrendService';
import type { serialisePackPagesDocument } from '@/modules/accounting/services/packs/pages/packDocumentWire';
import type { createShareLink, listShareLinks } from '@/modules/accounting/services/share/shareLinkService';
import type { CommentaryRow, generateDrafts, listCommentary } from '@/modules/accounting/services/commentary/commentaryService';
import type { createAnnotation, listAnnotations } from '@/modules/accounting/services/annotations/annotationService';
import type { getMonthlyMovements } from '@/modules/accounting/services/reports/trendRowsService';
import type { getBudgetVariance } from '@/modules/accounting/services/reports/budgetVarianceService';
import type { getIncomeStatement } from '@/modules/accounting/services/reports/financialReportingService';
import type { buildReportPack } from '@/modules/accounting/services/reports/reportPackService';
import type { unclassifiedWarning } from '@/modules/accounting/services/gl/financialFiguresService';

/**
 * ONE TYPE PER URL, REGARDLESS OF METHOD.
 * Matching is by pathname only — `apiJson` does not know the HTTP verb. A
 * route's registered type must therefore hold for EVERY method served at that
 * path. `/api/accounting/migration/session` qualifies: its GET and its POST
 * both return `{ session }`. If you ever add a method whose payload differs,
 * do NOT register the shared path — split the handler onto its own path, or
 * the second method silently inherits the first one's type and you have
 * recreated the confirmed-but-wrong guess this registry exists to prevent.
 *
 * A UNION is the second way out, and the one the WS3 routes below take. Where
 * a path's GET and POST genuinely return different payloads, registering the
 * union of both is safe for the same reason a single type is: no method
 * inherits another's shape. What it costs the caller is a narrowing step —
 * `'links' in r` — which TypeScript enforces, so a POST caller reading
 * `r.links` is a compile error rather than an undefined at runtime. Splitting
 * the handler onto its own path remains the better fix where the two payloads
 * have nothing to do with each other; a union is right when they are the list
 * and the item of one resource.
 *
 * THE CONDITION ON A UNION: its arms must stay DISJOINT on the key callers
 * narrow by. `'commentary' in r` only tells a caller which arm it holds while
 * exactly one arm has a `commentary` key. The day the other arm gains one,
 * every `in` check across the codebase silently stops discriminating and the
 * caller is back to a confirmed-but-wrong guess — with no compile error at the
 * call site, because both arms would then satisfy the narrowing. That is a
 * property of the SERVICE return types, which live in another module and are
 * changed by people who never read this file, so it is pinned by typeproof
 * cases 15-17 rather than by this comment.
 */
interface StaticRoutes {
  '/api/accounting/currencies': Currency[];
  '/api/accounting/migration/session': { session: MigrationSession | null };
  '/api/accounting/reports-vat-return': Awaited<ReturnType<typeof getVATReturn>>;
  '/api/accounting/vat-allocation-mismatches': Awaited<ReturnType<typeof findVatAllocationMismatches>>;
  // WS3. `token` and `url` exist on the POST response and nowhere else — the
  // raw token is never returned again, so no GET can carry it.
  '/api/accounting/share/links':
    | { links: Awaited<ReturnType<typeof listShareLinks>> }
    | { link: Awaited<ReturnType<typeof createShareLink>>['link']; token: string; url: string };
  '/api/accounting/commentary':
    | { commentary: Awaited<ReturnType<typeof listCommentary>> }
    | Awaited<ReturnType<typeof generateDrafts>>;
  '/api/accounting/annotations':
    | { annotations: Awaited<ReturnType<typeof listAnnotations>> }
    | { annotation: Awaited<ReturnType<typeof createAnnotation>> };
  '/api/accounting/reports-account-trends': Awaited<ReturnType<typeof getMonthlyMovements>>;
  '/api/accounting/reports-budget-comparator': {
    fiscalYear: Awaited<ReturnType<typeof getBudgetVariance>>['fiscalYear'];
    monthKeys: Awaited<ReturnType<typeof getBudgetVariance>>['monthKeys'];
    lines: Awaited<ReturnType<typeof getBudgetVariance>>['rows'];
    /** `result.rows.length` — how many accounts the SERVICE classified as
     *  budgeted. Derived in the handler, so it is written out here rather
     *  than projected off the service type; it is a count of that array and
     *  moves with it. */
    budgetedCount: number;
    postedThrough: Awaited<ReturnType<typeof getBudgetVariance>>['postedThrough'];
  };
  '/api/accounting/reports-income-statement': Awaited<ReturnType<typeof getIncomeStatement>>;
  '/api/accounting/reports-pack': {
    pack: ReturnType<typeof buildReportPack>;
    period: { from: string; to: string };
    unclassifiedAccounts: ReturnType<typeof unclassifiedWarning>;
  };
}

/**
 * Routes with a dynamic segment. Write the variable part as `{}` — the matcher
 * below binds it to exactly ONE path segment.
 *
 * A bare `` `/api/admin/users/${string}/impersonate` `` index signature would
 * be wrong: `${string}` spans slashes, so a future
 * `/api/admin/users/{id}/roles/impersonate` returning a different envelope
 * would silently inherit this type. That is precisely the defect class this
 * file exists to close, so the matcher rejects any binding containing `/`.
 */
interface DynamicRoutes {
  '/api/admin/users/{}/impersonate': { redirect: string };
  '/api/accounting/packs/{}/trend': Awaited<ReturnType<typeof getPackTrend>>;
  // The board pack document, composed server-side. Projected off the
  // SERIALISER rather than off `PackPagesDocument`, which is the point: the
  // wire shape differs from the model in exactly two ways (the chart brand is
  // widened to `string`, the provenance class to an array of figures), and
  // taking the type from the function that performs that transformation is
  // what stops the client's `adopt` walk being written against a shape the
  // server does not send.
  '/api/accounting/packs/{}/pages': ReturnType<typeof serialisePackPagesDocument>;
  // WS3. Each of these serves POST only, so each has one payload and needs no
  // union. The two commentary verbs return the same row shape by design: an
  // approval and a rejection differ in `status`, not in envelope.
  '/api/accounting/share/links/{}/revoke': { revoked: true };
  '/api/accounting/commentary/{}/approve': { commentary: CommentaryRow };
  '/api/accounting/commentary/{}/reject': { commentary: CommentaryRow };
  '/api/accounting/annotations/{}/resolve': { resolved: true };
}

export type ApiRouteMap = StaticRoutes & DynamicRoutes;

export type KnownRoute = keyof ApiRouteMap;

/** A single path segment: any string that does not span a `/` boundary. */
type Segment<S extends string> = S extends `${string}/${string}` ? never : S;

/** Strip a trailing query string or hash so callers can build URLs freely. */
type Path<U extends string> = U extends `${infer P}?${string}`
  ? P
  : U extends `${infer P}#${string}`
    ? P
    : U;

type MatchStatic<P extends string> = {
  [K in keyof StaticRoutes]: P extends K ? K : never;
}[keyof StaticRoutes];

type MatchDynamic<P extends string> = {
  [K in keyof DynamicRoutes]: K extends `${infer Pre}{}${infer Post}`
    ? P extends `${Pre}${infer Bound}${Post}`
      ? [Segment<Bound>] extends [never]
        ? never
        : K
      : never
    : never;
}[keyof DynamicRoutes];

/**
 * Resolve a concrete request URL to its registered route key, or `never` when
 * the route is not registered (which `ResponseFor` maps to `unknown`).
 */
export type RouteFor<U extends string> =
  | MatchStatic<Path<U>>
  | MatchDynamic<Path<U>>;

/**
 * The unwrapped `data` payload for a given request URL — or `unknown` when the
 * route is not registered.
 */
export type ResponseFor<U extends string> = [RouteFor<U>] extends [never]
  ? unknown
  : ApiRouteMap[RouteFor<U>];
