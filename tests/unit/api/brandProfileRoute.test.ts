/**
 * A pale brand colour is a normal thing for a user to try. It used to reach
 * withErrorHandler as a bare Error and come back as a 500 — "An unexpected
 * error occurred" in production — which never told anyone the colour was the
 * problem. It must be a 400 that names the failure. An unrelated failure must
 * still be a 500: a validation mapping that swallows real faults is worse than
 * the bug it fixes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/safeFetch', () => ({ checkPublicUrl: vi.fn(async () => null) }));

const upsertMock = vi.fn();
vi.mock('@/modules/accounting/services/afs/brandProfileService', () => ({
  getBrandProfile: vi.fn(async () => null),
  upsertBrandProfile: (...a: unknown[]) => upsertMock(...a),
}));

// withErrorHandler is deliberately REAL: the 500 half of this test is its
// behaviour, not the route's.
import route from '../../../pages/api/accounting/afs/brand-profile';
import { assertUsableBrandPrimary } from '@/lib/brand/contrast';

const COMPANY = '11111111-1111-4111-8111-111111111111';

function mockRes() {
  const res = {
    statusCode: 0, body: undefined as unknown, headers: {} as Record<string, unknown>,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    end(p?: unknown) { this.body = p; return this; },
    setHeader(k: string, v: unknown) { this.headers[k] = v; return this; },
  };
  return res as unknown as NextApiResponse & typeof res;
}

function putReq(body: Record<string, unknown>) {
  return {
    method: 'PUT', query: {}, url: '/api/accounting/afs/brand-profile',
    headers: {}, body, companyId: COMPANY, user: { id: 'u1' },
  } as unknown as NextApiRequest;
}

const VALID = {
  primaryColour: '#1a3a5c', secondaryColour: '#c8a86b',
  fontFamily: 'professional', coverStyle: 'classic',
};

beforeEach(() => { upsertMock.mockReset(); });

describe('PUT /api/accounting/afs/brand-profile', () => {
  it('returns 400 naming the contrast failure when the colour is too pale', async () => {
    upsertMock.mockImplementation(() => { assertUsableBrandPrimary('#f5f5f5', 'primaryColour'); });
    const res = mockRes();

    await route(putReq({ ...VALID, primaryColour: '#f5f5f5' }), res);

    expect(res.statusCode).toBe(400);
    const body = res.body as { success: boolean; error: { code: string; message: string } };
    expect(body.success).toBe(false);
    expect(body.error.message).toMatch(/primaryColour/);
    expect(body.error.message).toMatch(/#f5f5f5/);
    // Actionable: the user must be able to tell WHAT to change.
    expect(body.error.message).toMatch(/darker|lighter/i);
  });

  it('still returns 500 for an unrelated failure', async () => {
    upsertMock.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const res = mockRes();

    await route(putReq(VALID), res);

    expect(res.statusCode).toBe(500);
  });

  it('returns 200 with the saved profile when the colour is acceptable', async () => {
    upsertMock.mockResolvedValue({ companyId: COMPANY, primaryColour: '#1a3a5c' });
    const res = mockRes();

    await route(putReq(VALID), res);

    expect(res.statusCode).toBe(200);
    expect((res.body as { data: unknown }).data).toMatchObject({ primaryColour: '#1a3a5c' });
  });
});
