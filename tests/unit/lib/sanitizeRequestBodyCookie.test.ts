// Admin audit 2026-11-14, item 3.11: POST /api/admin/migration/sage-pull-server
// carries a live Sage session cookie as `sageCookie`. withAdmin's request logger
// (withErrorHandler -> loggableRequestBody) wrote it to the log in clear: no
// sensitive key or fragment matched it. A session cookie is a credential.
import { describe, expect, it } from 'vitest';
import { loggableRequestBody, loggableUrl } from '@/lib/sanitizeRequestBody';

const COOKIE = '.AspNet.ApplicationCookie=Ab3dEf9hIjKlMnOpQrStUvWx; ASP.NET_SessionId=zz11yy22';
const json = { 'content-type': 'application/json' };

describe('a session cookie in a request is never logged', () => {
  it('masks sageCookie in a JSON body and keeps the other fields', () => {
    const logged = loggableRequestBody({ headers: json, body: { companyId: 'c-1', sageCookie: COOKIE } });
    expect(logged).toEqual({ companyId: 'c-1', sageCookie: '[REDACTED]' });
  });

  it('masks any cookie-named key, in any spelling, at any depth', () => {
    const logged = loggableRequestBody({ headers: json, body: { pull: { session_cookie: COOKIE, SageCookie: COOKIE } } });
    expect(JSON.stringify(logged)).not.toContain('Ab3dEf9h');
  });

  it('masks a cookie passed in the query string', () => {
    expect(loggableUrl(`/api/admin/migration/sage-pull-server?sageCookie=${encodeURIComponent(COOKIE)}&x=1`))
      .toBe('/api/admin/migration/sage-pull-server?sageCookie=[REDACTED]&x=1');
  });
});
