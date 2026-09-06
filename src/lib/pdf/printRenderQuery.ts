// src/lib/pdf/printRenderQuery.ts
//
// Whether the current navigation is a PDF-transport print render — the same
// signal `pages/accounting/reports/report-packs.tsx` uses to choose
// `PackPrintPage` over the interactive screen: `?print=1`. Extracted to a
// pure function so `_app.tsx` can gate `CompanyProvider`'s fetch off print
// renders from the identical signal, rather than inventing a second one that
// could drift from the page's own branch.
//
// Gotenberg cannot intercept background network calls the way the
// Playwright transport does (see renderPagePdf.ts and gotenbergTransport.ts).
// `CompanyProvider`'s own fetch to `/api/accounting/companies` is not one of
// the print token's authorised paths, so under Gotenberg it 401s, and
// `apiFetch`'s global refresh-then-redirect (src/lib/apiFetch.ts) then
// navigates the whole render away to `/login` before it can finish. This
// selector is how `_app.tsx` recognises a print render and skips that fetch
// instead.

import type { ParsedUrlQuery } from 'querystring';

export function isPrintRenderQuery(query: ParsedUrlQuery): boolean {
  return query.print === '1';
}
