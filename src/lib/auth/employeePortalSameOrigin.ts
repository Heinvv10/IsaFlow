/**
 * Login CSRF guard for the employee portal's cookie-setting and cookie-clearing POSTs: login, accept, logout (wave 6 SS,
 * review #1570 L1). SameSite=Strict decides when the browser SENDS the cookie, not whether a cross-site response may
 * SET it, so without this a page on another site could post a form to login and sign the visitor into the attacker's
 * portal account. Refused (403, before the body is read):
 *   - a body that is not `application/json` (a cross-site HTML form cannot send it without a CORS preflight, which
 *     this app never answers);
 *   - `Sec-Fetch-Site` other than `same-origin`, when the browser sends it;
 *   - an `Origin` whose host is not this request's host, when it is sent;
 *   - neither `Origin` nor `Sec-Fetch-Site` (every current browser sends at least one on a POST).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function employeePortalPostRefusal(req: NextApiRequest): string | null {
  const type = (one(req.headers['content-type']) ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return 'content-type';
  const site = one(req.headers['sec-fetch-site']);
  const origin = one(req.headers.origin);
  if (!site && !origin) return 'no-origin';
  if (site && site !== 'same-origin') return 'cross-site';
  if (origin) {
    const hosts = [one(req.headers['x-forwarded-host']), one(req.headers.host)].filter(Boolean);
    let host: string;
    try { host = new URL(origin).host; } catch { return 'bad-origin'; }
    if (!hosts.includes(host)) return 'cross-origin';
  }
  return null;
}

export function withEmployeePortalSameOrigin(handler: Handler): Handler {
  return (req, res) => {
    if (req.method === 'POST' && employeePortalPostRefusal(req)) {
      return apiResponse.forbidden(res, 'This request did not come from the IsaFlow employee portal.');
    }
    return handler(req, res);
  };
}
