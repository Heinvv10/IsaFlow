import { describe, it, expect } from 'vitest';
import {
  buildGotenbergFields, GOTENBERG_TIMEOUT_MS, GOTENBERG_API_TIMEOUT_MS, GOTENBERG_CLIENT_MARGIN_MS,
} from '@/lib/pdf/transports/gotenbergForm';
import { PRINT_READY_SELECTOR, PRINT_READY_TIMEOUT_MS } from '@/lib/pdf/pdfTransport';

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
    expect(f.marginTop).toBe('0.79');
    expect(f.marginLeft).toBe('0.71');
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

  /**
   * The residual documented in gotenbergForm.ts and src/lib/pdf/.claude.md:
   * Gotenberg's cookie object requires `domain` and exposes no host-only or
   * `url` form, so a bare hostname is the tightest scope expressible. What
   * this pins is that it stays the tightest one — a leading dot or a wildcard
   * would widen the print token to every subdomain, and the container's
   * --chromium-allow-list is what keeps the bare form contained.
   */
  it('never widens the cookie scope with a leading dot or a wildcard', () => {
    const f = buildGotenbergFields(request, env);
    const cookies = JSON.parse(f.cookies) as Array<{ domain: string }>;
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) {
      expect(c.domain).toBe('app.isaflow.co.za');
      expect(c.domain.startsWith('.')).toBe(false);
      expect(c.domain).not.toContain('*');
    }
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

/**
 * ADVERSARIAL LOW-4: the client timeout was exactly Gotenberg's own
 * --api-timeout. Equal is a race — whichever clock reaches 60s first wins — so
 * the same slow render surfaced as a Gotenberg 5xx or as a client AbortError
 * depending on scheduling, and only the server's answer says what went wrong.
 */
describe('GOTENBERG_TIMEOUT_MS', () => {
  it('expires strictly before the container aborts, with a real margin', () => {
    expect(GOTENBERG_TIMEOUT_MS).toBeLessThan(GOTENBERG_API_TIMEOUT_MS);
    expect(GOTENBERG_API_TIMEOUT_MS - GOTENBERG_TIMEOUT_MS).toBeGreaterThanOrEqual(GOTENBERG_CLIENT_MARGIN_MS);
  });

  it('still leaves room for the whole print-ready gate plus transport overhead', () => {
    expect(GOTENBERG_TIMEOUT_MS).toBeGreaterThan(PRINT_READY_TIMEOUT_MS);
  });
});

describe('buildGotenbergFields metadata', () => {
  it("sends PDF metadata as Gotenberg's JSON metadata field when present", () => {
    const f = buildGotenbergFields(
      { ...request, metadata: { title: 'T', author: 'A', subject: 'S', creator: 'IsaFlow' } },
      env,
    );
    expect(JSON.parse(f.metadata as string)).toMatchObject({ Title: 'T', Creator: 'IsaFlow' });
  });

  it('omits the metadata field entirely when none is supplied', () => {
    const f = buildGotenbergFields(request, env);
    expect(f).not.toHaveProperty('metadata');
  });
});
