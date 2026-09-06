// src/lib/auth/withAuthPrint.ts
//
// The print-pipeline fallback withAuth takes when GoTrue verification fails:
// a headless Chromium request (src/lib/pdf/renderPagePdf.ts) carrying a
// short-lived print token in the SAME cookie a GoTrue session uses.
//
// Extracted from withAuth for one reason: the branch used to re-implement the
// bound-path check inline against verifyPrintTokenSignature, so the tested
// function (verifyPrintToken, with its exact-match and prefix-widening tests)
// had no production caller and the code that actually ran was untested. The
// path decision now goes through verifyPrintToken and nowhere else.
//
// The two-outcome shape is deliberate. A garbage/forged/expired token is a
// dead session: clear the cookies and 401 as normal. A genuine token bound to
// DIFFERENT paths is not — AppLayout's own background calls present the same
// print-token cookie, and clearing cookies for those was wiping the render's
// credentials mid-render. Those 401 WITHOUT clearing.

import { verifyPrintToken, verifyPrintTokenSignature, type PrintTokenPayload } from '@/lib/pdf/printAuth';

export type PrintTokenOutcome =
  | { kind: 'accepted'; payload: PrintTokenPayload }
  /** `clearCookies` is true only for a token that is not genuine at all. */
  | { kind: 'rejected'; clearCookies: boolean };

/**
 * Decide whether a print token authorises this request.
 *
 * `requestPath` must already have the query string stripped — the token binds
 * pathnames, and printAuth matches them with `===`, never by prefix.
 */
export function authenticatePrintToken(
  token: string,
  requestPath: string,
  activeCompanyId: string,
): PrintTokenOutcome {
  const payload = verifyPrintToken(token, requestPath);
  if (payload) {
    // A token is bound to a company as well as a path set: the active-company
    // cookie is attacker-controllable, and without this a print token could
    // read another tenant under a swapped cookie.
    if (payload.companyId !== activeCompanyId) return { kind: 'rejected', clearCookies: false };
    return { kind: 'accepted', payload };
  }

  // verifyPrintToken said no. Signature-only tells the two refusals apart:
  // a token that verifies here is genuine and merely bound elsewhere (or
  // expired — verifyPrintTokenSignature rejects those too, so they clear).
  return { kind: 'rejected', clearCookies: verifyPrintTokenSignature(token) === null };
}
