/**
 * Intercompany P5, review round 1 (d): the report's route checks the person ONCE per request (in the service, not again in the route), and
 * the order of plan section (c) still holds: a person who may not read gets the 403 before a bad request is judged (never a 400 that tells
 * them the request shape); a reader with a bad request gets the 400 with its fixed sentence; nothing is read for either. The service's
 * reads are mocked: what is pinned here is the order and the count of the person checks, through the real route and service.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

type H = (req: NextApiRequest, res: NextApiResponse) => unknown;
vi.mock('@/lib/auth', () => ({ withAuth: (h: H) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: H) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ withSavepoint: vi.fn(async (_n: string, fn: () => unknown) => fn()), sql: vi.fn() }));
vi.mock('@/lib/auth/impersonationSessions', () => ({ currentSessionActor: vi.fn() }));
vi.mock('@/modules/accounting/services/intercompany/loanClearingGate', () => ({ loanClearingEnabled: vi.fn() }));
vi.mock('@/modules/accounting/services/intercompany/allocationClearReads', () => ({ userCanWrite: vi.fn() }));
vi.mock('@/modules/accounting/services/intercompany/loanReconReads', () => ({
  boundStatement: vi.fn(async () => '0'), restoreStatement: vi.fn(), countReconMessages: vi.fn(async () => 0),
  readReconConnections: vi.fn(async () => [{ id: '33333333-3333-4333-8333-333333333333', status: 'active', settlement_mode: 'loan', partner_name: 'Partner' }]),
  readReconStatement: vi.fn(async () => ({
    summary: { partner_state: 'ok', as_of: '2026-11-24', own_balance: '0', own_attributed: '0', own_other: '0', own_loan_shared: false, partner_balance: '0', partner_other: '0' },
    messages: [], unsent: [], unlinked: [], cutover: '2026-01-01', read_at: '2026-11-24T08:00:00.000Z',
  })),
}));

const CONN = '33333333-3333-4333-8333-333333333333';

import { currentSessionActor } from '@/lib/auth/impersonationSessions';
import { loanClearingEnabled } from '@/modules/accounting/services/intercompany/loanClearingGate';
import { userCanWrite } from '@/modules/accounting/services/intercompany/allocationClearReads';
import { readReconStatement } from '@/modules/accounting/services/intercompany/loanReconReads';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import handler from '../../../../pages/api/accounting/intercompany/loan-reconciliation/[connectionId]';

async function call(query: Record<string, string>) {
  const req = { method: 'GET', query, headers: {}, cookies: {}, companyId: 'co-s', user: { id: 'u-1' } };
  const res = {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, unknown>,
    setHeader(k: string, v: unknown) { this.headers[k] = v; return this; }, getHeader() { return undefined; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  await (handler as H)(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentSessionActor).mockResolvedValue('self');
  vi.mocked(loanClearingEnabled).mockResolvedValue(true);
  vi.mocked(userCanWrite).mockResolvedValue(true);
});

describe('GET loan-reconciliation/[connectionId]: one person check, before the request', () => {
  it('a report: 200 with the person checked exactly once (session, flag, role each asked once)', async () => {
    const res = await call({ connectionId: CONN, section: 'undone' });
    expect(res.statusCode).toBe(200);
    expect(currentSessionActor).toHaveBeenCalledTimes(1);
    expect(loanClearingEnabled).toHaveBeenCalledTimes(1);
    expect(userCanWrite).toHaveBeenCalledTimes(1);
    expect(readReconStatement).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => void, string]>([
    ['no intercompany write role', () => vi.mocked(userCanWrite).mockResolvedValue(false), 'forbidden'],
    ['the flag off', () => vi.mocked(loanClearingEnabled).mockResolvedValue(false), 'not_enabled'],
    ['a Login-as session', () => vi.mocked(currentSessionActor).mockResolvedValue('impersonation'), 'impersonating'],
  ])('%s with a bad request (an asOf): 403 %s, not 400; nothing read', async (_n, make, reason) => {
    make();
    const res = await call({ connectionId: CONN, asOf: '2026-01-01' });
    expect(res.statusCode).toBe(403);
    expect(res.sent).toMatchObject({ error: { details: { reason } } });
    expect(readReconStatement).not.toHaveBeenCalled();
  });

  it('a reader with a bad request: 400 with its fixed sentence, the person checked once, nothing read', async () => {
    const res = await call({ connectionId: CONN, asOf: '2026-01-01' });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toContain('The report is as of today: it takes no date.');
    expect(currentSessionActor).toHaveBeenCalledTimes(1);
    expect(readReconStatement).not.toHaveBeenCalled();
  });
});
