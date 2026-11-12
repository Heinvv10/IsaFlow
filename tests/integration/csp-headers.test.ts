import { describe, it, expect } from 'vitest';
import { IN_INTEGRATION_GATE } from '../helpers/integrationGate';

const BASE = 'http://localhost:3200';

// ci-integration-skip: drives a running dev server over HTTP (TEST_BASE_URL, default localhost:3200); the CI gate starts none. Run it with bun run test:integration beside bun run dev.
describe.skipIf(IN_INTEGRATION_GATE)('CSP response headers (BL-31)', () => {
  it('includes additive directives on the root path', async () => {
    const res = await fetch(`${BASE}/`);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain('upgrade-insecure-requests');
  });
});
