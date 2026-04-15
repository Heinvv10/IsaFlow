/**
 * Integration test: BL-32 — legacy ff_auth_token cookie must be rejected
 *
 * Security finding S-009: the ff_auth_token cookie fallback allowed sessions
 * established under the old cookie name to continue working indefinitely,
 * bypassing the security boundary introduced by renaming to isaflow_auth.
 *
 * Properties under test:
 *   A. extractToken() returns null when only ff_auth_token is present —
 *      the fallback read path has been removed.
 *   B. extractToken() still returns the token when isaflow_auth is present.
 *
 * This tests the actual code path (no running server required) since the
 * fallback was in extractToken() itself.
 */

import { describe, it, expect } from 'vitest';
import { extractToken } from '@/lib/auth/sessionHelpers';
import type { NextApiRequest } from 'next';

function makeReq(cookies: Record<string, string>): NextApiRequest {
  return {
    cookies,
    headers: {},
  } as unknown as NextApiRequest;
}

describe('legacy ff_auth_token cookie (BL-32)', () => {
  it('returns null when only ff_auth_token is present — fallback removed (S-009)', () => {
    const req = makeReq({ ff_auth_token: 'somevalue' });
    // After BL-32 removal the fallback is gone — must return null, not 'somevalue'
    expect(extractToken(req)).toBeNull();
  });

  it('still returns token when isaflow_auth is present', () => {
    const req = makeReq({ isaflow_auth: 'valid.jwt.token' });
    expect(extractToken(req)).toBe('valid.jwt.token');
  });

  it('prefers isaflow_auth over ff_auth_token if both are present', () => {
    const req = makeReq({ isaflow_auth: 'new.token', ff_auth_token: 'old.token' });
    expect(extractToken(req)).toBe('new.token');
  });
});
