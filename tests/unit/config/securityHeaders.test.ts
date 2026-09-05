// Pentest WS-5 (M9 / agent5 M2, L3): CSP wildcard tightening + X-XSS-Protection.
// The header/CSP builder lives in a CJS module (config/securityHeaders.js) so it
// can be unit-tested directly without loading the Sentry-wrapped next.config.js.
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildCsp, securityHeaders } = require('../../../config/securityHeaders');

function directive(csp: string, name: string): string {
  const parts = csp.split(';').map((s) => s.trim());
  const hit = parts.find((p) => p === name || p.startsWith(name + ' '));
  return hit ?? '';
}

describe('securityHeaders — production CSP', () => {
  const csp = buildCsp('production');

  it('does NOT use the *.isaflow.co.za wildcard in connect-src (M2)', () => {
    expect(directive(csp, 'connect-src')).not.toContain('*.isaflow.co.za');
  });

  it('does NOT use the *.isaflow.co.za wildcard in img-src (M2)', () => {
    expect(directive(csp, 'img-src')).not.toContain('*.isaflow.co.za');
  });

  it('enumerates the exact isaflow subdomains in connect-src (app/admin/errors)', () => {
    const connect = directive(csp, 'connect-src');
    expect(connect).toContain('https://app.isaflow.co.za');
    expect(connect).toContain('https://admin.isaflow.co.za');
    // client-side Sentry/Bugsink posts events to errors.isaflow.co.za
    expect(connect).toContain('https://errors.isaflow.co.za');
  });

  it('enumerates the exact isaflow subdomains in img-src (app/admin)', () => {
    const img = directive(csp, 'img-src');
    expect(img).toContain('https://app.isaflow.co.za');
    expect(img).toContain('https://admin.isaflow.co.za');
  });

  it('keeps script-src locked down (no unsafe-inline / unsafe-eval) in prod', () => {
    const script = directive(csp, 'script-src');
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it('still allows the third-party provider hosts the app depends on', () => {
    // Sage API (external) legitimately needs a subdomain wildcard.
    expect(directive(csp, 'connect-src')).toContain('https://*.sageone.co.za');
    expect(directive(csp, 'img-src')).toContain('https://*.gravatar.com');
  });

  it('retains the hardened invariants', () => {
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'base-uri')).toBe("base-uri 'self'");
  });

  // Task 12 fix round 1: `upgrade-insecure-requests` must be prod-only. Applied
  // unconditionally, it made Gotenberg's Chromium upgrade dev's plain-HTTP
  // subresources to HTTPS, which the dev server can't answer — the page never
  // hydrates and [data-print-ready] never appears. Production is HTTPS end to
  // end, so the directive is a genuine hardening there.
  it('sets upgrade-insecure-requests in production', () => {
    expect(csp).toContain('upgrade-insecure-requests');
  });
});

describe('securityHeaders — dev CSP', () => {
  const csp = buildCsp('development');
  it('does NOT use the *.isaflow.co.za wildcard in connect-src', () => {
    expect(directive(csp, 'connect-src')).not.toContain('*.isaflow.co.za');
  });
  it('does NOT use the *.isaflow.co.za wildcard in img-src', () => {
    expect(directive(csp, 'img-src')).not.toContain('*.isaflow.co.za');
  });
  it('keeps localhost dev connect targets', () => {
    expect(directive(csp, 'connect-src')).toContain('http://localhost:3101');
  });

  // Task 12 fix round 1: see the production test above for why this must be
  // absent in dev.
  it('does NOT set upgrade-insecure-requests', () => {
    expect(csp).not.toContain('upgrade-insecure-requests');
  });
});

describe('securityHeaders — header set', () => {
  const headers = securityHeaders('production');
  const get = (k: string) => headers.find((h: { key: string }) => h.key === k);

  it('adds X-XSS-Protection: 0 (L3 — disables the buggy legacy auditor)', () => {
    expect(get('X-XSS-Protection')?.value).toBe('0');
  });

  it('preserves the existing core security headers', () => {
    expect(get('X-Frame-Options')?.value).toBe('DENY');
    expect(get('X-Content-Type-Options')?.value).toBe('nosniff');
    expect(get('Strict-Transport-Security')?.value).toContain('max-age=31536000');
    expect(get('Content-Security-Policy')?.value).toBeTruthy();
  });

  it('uses the production CSP when NODE_ENV=production', () => {
    expect(get('Content-Security-Policy')?.value).toBe(buildCsp('production'));
  });
});
