import { describe, it, expect } from 'vitest';
import { buildGotenbergFields } from '@/lib/pdf/transports/gotenbergForm';
import { PRINT_READY_SELECTOR } from '@/lib/pdf/pdfTransport';

const env = { APP_URL: 'https://app.isaflow.co.za' };
const httpEnv = { APP_URL: 'http://host.docker.internal:3200' };

const request = {
  url: 'https://app.isaflow.co.za/accounting/reports/report-packs?pack=management&print=1',
  landscape: false,
  allowedApiPaths: ['/api/accounting/reports-pack'],
  cookies: [
    { name: 'sb-access-token', value: 'tok.sig', httpOnly: true },
    { name: 'active_company_id', value: 'c-1', httpOnly: false },
  ],
};

describe('buildGotenbergFields', () => {
  it('sends the page URL and A4 geometry in inches', () => {
    const f = buildGotenbergFields(request, env);
    expect(f.url).toBe(request.url);
    expect(f.paperWidth).toBe('8.27');
    expect(f.paperHeight).toBe('11.69');
    expect(f.marginTop).toBe('0.71');
    expect(f.marginLeft).toBe('0.55');
  });

  it('waits for the print-ready flag rather than a fixed delay', () => {
    const f = buildGotenbergFields(request, env);
    expect(f.waitForExpression).toContain(JSON.stringify(PRINT_READY_SELECTOR));
    expect(f.waitForExpression).toBe(`document.querySelector(${JSON.stringify(PRINT_READY_SELECTOR)}) !== null`);
    expect(f.waitDelay).toBeUndefined();
  });

  it('emulates print media and prints backgrounds', () => {
    const f = buildGotenbergFields(request, env);
    expect(f.emulatedMediaType).toBe('print');
    expect(f.printBackground).toBe('true');
  });

  it('carries every cookie in the cookies field, never in extraHttpHeaders', () => {
    const f = buildGotenbergFields(request, env);
    expect(f.extraHttpHeaders).toBeUndefined();

    const cookies = JSON.parse(f.cookies) as Array<{ name: string; value: string; domain: string }>;
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatchObject({ name: 'sb-access-token', value: 'tok.sig', domain: 'app.isaflow.co.za' });
    expect(cookies[1]).toMatchObject({ name: 'active_company_id', value: 'c-1', domain: 'app.isaflow.co.za' });
  });

  it('scopes every cookie to the app host from APP_URL, not a wildcard', () => {
    const f = buildGotenbergFields(request, env);
    const cookies = JSON.parse(f.cookies) as Array<{ domain: string }>;
    expect(cookies.every((c) => c.domain === 'app.isaflow.co.za')).toBe(true);
  });

  it('falls back to NEXT_PUBLIC_APP_URL when APP_URL is unset', () => {
    const f = buildGotenbergFields(request, { NEXT_PUBLIC_APP_URL: 'https://app.isaflow.co.za' });
    const cookies = JSON.parse(f.cookies) as Array<{ domain: string }>;
    expect(cookies[0].domain).toBe('app.isaflow.co.za');
  });

  it('throws when neither APP_URL nor NEXT_PUBLIC_APP_URL is set', () => {
    expect(() => buildGotenbergFields(request, {})).toThrow(/APP_URL/);
  });

  it('marks cookies Secure when the app URL is https', () => {
    const f = buildGotenbergFields(request, env);
    const cookies = JSON.parse(f.cookies) as Array<{ secure: boolean }>;
    expect(cookies.every((c) => c.secure === true)).toBe(true);
  });

  it('marks cookies NOT Secure when the app URL is http, so the local docker setup actually authenticates', () => {
    const f = buildGotenbergFields(request, httpEnv);
    const cookies = JSON.parse(f.cookies) as Array<{ secure: boolean }>;
    expect(cookies.every((c) => c.secure === false)).toBe(true);
  });

  it('sets landscape only when asked', () => {
    expect(buildGotenbergFields(request, env).landscape).toBe('false');
    expect(buildGotenbergFields({ ...request, landscape: true }, env).landscape).toBe('true');
  });
});
