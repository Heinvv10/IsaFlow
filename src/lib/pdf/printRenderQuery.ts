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
// Why this takes the router rather than the query: on a page with no
// `getServerSideProps`, Next.js Pages Router leaves `router.query` as `{}`
// on the first CLIENT-side render pass, until the router finishes parsing
// the URL and flips `router.isReady`. Branching on `query` alone therefore
// evaluates "not a print render" once, which is long enough for
// `AuthProvider`'s mount effect to fire `/api/auth/me` and destroy the print
// token's cookie. During that window we read the URL directly instead —
// `window.location.search` is correct from the very first client render.
// On the server there is no `window`; the server pass mounts no effects and
// the client pass corrects the branch, so `false` is safe there.

import type { NextRouter } from 'next/router';

export function isPrintRender(router: Pick<NextRouter, 'isReady' | 'query'>): boolean {
  if (router.isReady) return router.query.print === '1';
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('print') === '1';
}
