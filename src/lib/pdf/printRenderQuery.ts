// src/lib/pdf/printRenderQuery.ts
//
// Whether the current navigation is a PDF-transport print render — the same
// signal `pages/accounting/reports/report-packs.tsx` uses to choose
// `PackPrintPage` over the interactive screen: `?print=1`. Extracted to a
// pure function so `_app.tsx` can gate `AuthProvider`'s and
// `CompanyProvider`'s fetches off print renders from the identical signal,
// rather than inventing a second one that could drift from the page's own
// branch.
//
// Gotenberg cannot intercept background network calls the way the
// Playwright transport does (see renderPagePdf.ts and gotenbergTransport.ts).
// `CompanyProvider`'s own fetch to `/api/accounting/companies` is not one of
// the print token's authorised paths, so under Gotenberg it 401s, and
// `apiFetch`'s global refresh-then-redirect (src/lib/apiFetch.ts) then
// navigates the whole render away to `/login` before it can finish.
// `AuthProvider`'s `/api/auth/me` is worse: its `withUserAuth` wrapper
// (src/lib/auth/withUserAuth.ts) fails JWT verification on a print token and
// CLEARS the `sb-access-token` cookie — the same cookie carrying that print
// token — so every later request in the render 401s.
//
// Why this takes the router rather than the query: `router.query` is the
// authority once the router is ready, and `router.isReady` is the only thing
// that says whether it is. There used to be a `window.location` fallback for
// the not-ready window, because a page with no `getServerSideProps` leaves
// `query` as `{}` on the first CLIENT pass — long enough for `AuthProvider`'s
// mount effect to fire and destroy the print token's cookie. The pack page now
// has `getServerSideProps` (see its own docstring: without it the server and
// client rendered different trees and hydration failed), so `isReady` is true
// from the very first client render and that window does not exist. Reading
// `window.location` for a state that cannot occur is a second source of truth
// that nothing exercises, so it is gone: not ready means not a print render.

import type { NextRouter } from 'next/router';

/**
 * The one page the PDF pipeline renders. The gate is scoped to it because
 * `?print=1` is not a reserved parameter: any other page could carry one for
 * its own reasons, and a global gate would silently strip that page's auth and
 * company context and leave it broken with no error. Only this page has a
 * print branch, so only this page needs the providers gated.
 */
export const PRINT_RENDER_PATH = '/accounting/reports/report-packs';

export function isPrintRender(router: Pick<NextRouter, 'isReady' | 'query' | 'pathname'>): boolean {
  if (!router.isReady) return false;
  return router.pathname === PRINT_RENDER_PATH && router.query.print === '1';
}
