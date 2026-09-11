/**
 * sageSession.ts
 *
 * How IsaFlow authenticates to Sage Business Cloud with an operator-supplied
 * browser session cookie. One definition, shared by the server-side pull and
 * the read-only allocation probe, so the probe cannot drift from the auth the
 * pull actually uses.
 */

export const DEFAULT_SAGE_BASE = 'https://accounting.sageone.co.za';
// M5: the caller-supplied sageBase must be a Sage host — never let the cookie be
// replayed to an attacker-chosen internal/metadata endpoint (SSRF).
export const SAGE_ALLOWED_HOSTS = ['sageone.co.za'];

export function buildSageHeaders(cookie: string): Record<string, string> {
  // Caller passes the full `Cookie:` value (a `name=value; name=value` string
  // for every cookie set by sageone.co.za). If they pass just a single cookie
  // value, prefix it; otherwise replay the string verbatim.
  const cookieHeader = cookie.includes('=') ? cookie : `.AspNet.ApplicationCookie=${cookie}`;
  return {
    'Content-Type': 'application/json;charset=UTF-8',
    'Accept': 'application/json',
    'Cookie': cookieHeader,
    'X-Requested-With': 'XMLHttpRequest',
  };
}
