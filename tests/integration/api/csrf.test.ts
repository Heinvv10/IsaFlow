import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3200';
const PROTECTED_ENDPOINT = '/api/accounting/bank-transactions-action';
// Machine-local artefact minted out of band by the operator, not by this suite.
// Without it every assertion here is meaningless, so skip rather than error —
// same posture as the other guarded integration files.
const TOKEN_FILE = '/tmp/isaflow-admin-token.env';

describe.skipIf(!existsSync(TOKEN_FILE))('CSRF on money-moving endpoints (BL-22)', () => {
  let authToken: string;

  beforeAll(async () => {
    // Read the pre-minted admin token
    const fs = await import('node:fs');
    const env = fs.readFileSync(TOKEN_FILE, 'utf-8');
    authToken = env.match(/TOKEN=(.+)/)?.[1] ?? '';
    expect(authToken.length).toBeGreaterThan(0);
  });

  it('GET does NOT require CSRF', async () => {
    const res = await fetch(`${BASE}${PROTECTED_ENDPOINT}`, {
      method: 'GET',
      headers: { Cookie: `isaflow_auth=${authToken}`, 'X-Company-Id': '00000000-0000-0000-0000-000000000001' },
    });
    // 405 Method Not Allowed or 200 — just not 403 CSRF
    expect(res.status).not.toBe(403);
  });

  it('POST without CSRF cookie + header → 403', async () => {
    const res = await fetch(`${BASE}${PROTECTED_ENDPOINT}`, {
      method: 'POST',
      headers: {
        Cookie: `isaflow_auth=${authToken}`,
        'X-Company-Id': '00000000-0000-0000-0000-000000000001',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'noop' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error?.code).toBe('FORBIDDEN');
    expect(body.error?.message).toContain('CSRF');
  });

  it('POST with mismatched cookie and header → 403', async () => {
    const res = await fetch(`${BASE}${PROTECTED_ENDPOINT}`, {
      method: 'POST',
      headers: {
        Cookie: `isaflow_auth=${authToken}; isaflow_csrf=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
        'X-Company-Id': '00000000-0000-0000-0000-000000000001',
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      body: JSON.stringify({ action: 'noop' }),
    });
    expect(res.status).toBe(403);
  });

  it('POST with matching cookie and header → not 403', async () => {
    const token = 'a'.repeat(64);
    const res = await fetch(`${BASE}${PROTECTED_ENDPOINT}`, {
      method: 'POST',
      headers: {
        Cookie: `isaflow_auth=${authToken}; isaflow_csrf=${token}`,
        'X-Company-Id': '00000000-0000-0000-0000-000000000001',
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
      },
      body: JSON.stringify({ action: 'noop' }),
    });
    expect(res.status).not.toBe(403);  // handler-level behavior depends on body; just prove CSRF passed
  });
});
