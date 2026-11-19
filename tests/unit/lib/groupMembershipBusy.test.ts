/**
 * 1002's group-membership changers fail with SQLSTATE 55P03 and "try again in a moment" when they cannot find a gap in the
 * traffic of the companies involved within their budget. Every membership and group writer (removeMember, deleteGroup,
 * addMember, updateGroup) reaches the client through withErrorHandler, so it must be a 503 with Retry-After and a neutral
 * message, not a 500 with the driver's text. Both the typed predicate and the whole wrapper are checked.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { isHeldRowError } from '@/lib/lockTimeout';
import { respondToUnhandledError, withErrorHandler } from '@/lib/api-error-handler';

const TRIGGER_ERROR = Object.assign(new Error('a group membership change is waiting on other work in the group; try again in a moment'), { code: '55P03' });

const fakeRes = () => {
  const res = {
    statusCode: 0, headers: {} as Record<string, string>, body: undefined as unknown, headersSent: false, writableEnded: false,
    setHeader: vi.fn((k: string, v: string) => { res.headers[k] = v; }),
    status: vi.fn((c: number) => { res.statusCode = c; return res; }),
    json: vi.fn((b: unknown) => { res.body = b; return res; }),
    end: vi.fn(),
  };
  return res;
};

describe('the membership changer\'s 55P03', () => {
  it('is a held-row error', () => expect(isHeldRowError(TRIGGER_ERROR)).toBe(true));

  it('answers 503 + Retry-After with the neutral message (no driver text, no trigger wording)', () => {
    const res = fakeRes();
    respondToUnhandledError(res as unknown as NextApiResponse, TRIGGER_ERROR);
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
    expect(JSON.stringify(res.body)).toMatch(/retry in a moment/);
    expect(JSON.stringify(res.body)).not.toMatch(/group membership change|waiting on other work/);
  });

  it('a route handler that throws it (removeMember, deleteGroup, addMember) answers 503 through withErrorHandler', async () => {
    const res = fakeRes();
    const handler = withErrorHandler(async () => { throw TRIGGER_ERROR; });
    await handler({ method: 'PUT', url: '/api/accounting/company-groups', headers: {}, query: {}, body: {} } as unknown as NextApiRequest, res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
  });

  it('other errors are untouched: a 500 for a plain error, not a held row', () => {
    expect(isHeldRowError(Object.assign(new Error('x'), { code: '23514' }))).toBe(false);
  });
});
