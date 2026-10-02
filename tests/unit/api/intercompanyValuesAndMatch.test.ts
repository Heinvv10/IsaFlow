/**
 * D4 round 10 (blind review of 5446d243c): intercompany-transactions create validates
 * transactionType (the known list), amount (a positive finite number) and transactionDate (a real
 * ledger date) — typeof first — with 400 before any query; each used to reach SQL and 500. And a
 * match that names a transaction not in this group is a typed not-found answered 404, not a 500.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const access = vi.hoisted(() => ({ userBelongsToGroup: vi.fn(), userCanWriteGroup: vi.fn() }));
const svc = vi.hoisted(() => ({
  listIntercompanyTransactions: vi.fn(), createIntercompanyTransaction: vi.fn(), matchIntercompanyTransactions: vi.fn(),
  getIntercompanyReconciliation: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ ok: 1 }]) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/companyAccessService', () => access);
vi.mock('@/modules/accounting/services/reports/groupCompanyService', () => svc);

import handler from '../../../pages/api/accounting/intercompany-transactions';
import { IntercompanyNotFoundError, INTERCOMPANY_TRANSACTION_TYPES } from '@/modules/accounting/services/reports/intercompanyService';
import { TX_TYPES } from '@/components/accounting/group/IntercompanyShared';

const G = '80000000-0000-4000-8000-000000000001';
const A = '10000000-0000-4000-8000-0000000000a1';
const B = '10000000-0000-4000-8000-0000000000a2';
const T1 = '60000000-0000-4000-8000-000000000001';
const T2 = '60000000-0000-4000-8000-000000000002';
const CREATE = { groupId: G, sourceCompanyId: A, targetCompanyId: B, transactionType: 'sale', amount: 1250.5, transactionDate: '2026-01-15' };

async function call(body: Record<string, unknown>) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
  await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(
    { method: 'POST', query: {}, body, user: { id: 'u1' } } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}
const msg = (res: { json: ReturnType<typeof vi.fn> }) => JSON.stringify(res.json.mock.calls[0]?.[0] ?? {});

beforeEach(() => {
  for (const fn of [...Object.values(access), ...Object.values(svc)]) fn.mockReset().mockResolvedValue(true);
  svc.createIntercompanyTransaction.mockResolvedValue({ id: 'tx' });
});

describe('create: values are validated before any query (400)', () => {
  it.each([
    [{ transactionType: 'gift' }, 'transactionType must be one of'],
    [{ transactionType: ['sale'] }, 'transactionType must be one of'],
    [{ amount: '1250.50' }, 'amount must be a positive number'],
    [{ amount: -5 }, 'amount must be a positive number'],
    [{ amount: -0.5 }, 'amount must be a positive number'],
    // NUMERIC(15,2): 1e13 overflowed (a 500) and 0.001 was stored as 0.00 (blind review of 28cd87199).
    [{ amount: 1e13 }, 'amount must be less than'],
    [{ amount: 0.001 }, 'at most 2 decimal places'],
    [{ amount: 10.005 }, 'at most 2 decimal places'],
    [{ amount: 1e-7 }, 'at most 2 decimal places'],
    [{ amount: Number.POSITIVE_INFINITY }, 'amount must be a positive number'],
    [{ transactionDate: '2026-02-30' }, 'transactionDate must be a real date'],
    [{ transactionDate: ['2026-01-15'] }, 'transactionDate must be a real date'],
    [{ transactionDate: '15/01/2026' }, 'transactionDate must be a real date'],
    [{ currency: 710 }, 'currency must be a string'],
    [{ description: { x: 1 } }, 'description must be a string'],
  ])('%j → 400', async (patch, message) => {
    const res = await call({ ...CREATE, ...patch });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(msg(res)).toContain(message);
    expect(access.userBelongsToGroup).not.toHaveBeenCalled();
    expect(svc.createIntercompanyTransaction).not.toHaveBeenCalled();
  });

  it('a valid body is recorded', async () => {
    const res = await call(CREATE);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(svc.createIntercompanyTransaction).toHaveBeenCalledWith(expect.objectContaining({ transactionType: 'sale', amount: 1250.5, transactionDate: '2026-01-15' }));
  });

  it.each([0.01, 0.07, 1250.5, 9999999999999.99])('amount %d fits NUMERIC(15,2) and is recorded', async (amount) => {
    const res = await call({ ...CREATE, amount });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(svc.createIntercompanyTransaction).toHaveBeenCalledWith(expect.objectContaining({ amount }));
  });

  it('every type the page offers is accepted, and no other', () => {
    expect(TX_TYPES.map(t => t.value)).toEqual([...INTERCOMPANY_TRANSACTION_TYPES]);
  });
});

describe('match: a transaction not in this group → 404', () => {
  it('answers 404 naming the missing id', async () => {
    svc.matchIntercompanyTransactions.mockRejectedValue(new IntercompanyNotFoundError([T2]));
    const res = await call({ action: 'match', groupId: G, sourceId: T1, targetId: T2 });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(msg(res)).toContain(T2);
  });

  it('any other failure still propagates (500)', async () => {
    svc.matchIntercompanyTransactions.mockRejectedValue(new Error('connection reset'));
    await expect(call({ action: 'match', groupId: G, sourceId: T1, targetId: T2 })).rejects.toThrow('connection reset');
  });
});
