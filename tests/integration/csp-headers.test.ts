import { describe, it, expect } from 'vitest';

const BASE = 'http://localhost:3200';

describe('CSP response headers (BL-31)', () => {
  it('includes additive directives on the root path', async () => {
    const res = await fetch(`${BASE}/`);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain('upgrade-insecure-requests');
  });
});
