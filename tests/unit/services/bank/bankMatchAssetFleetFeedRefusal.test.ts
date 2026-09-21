/**
 * Task 3 (fix round 1, finding 3) — bank-match-asset / bank-match-fleet write
 * another table BEFORE the bank_transactions row, so they can't rely on a
 * predicate: they read feed_state first and refuse before any write.
 *
 *   - row not found for this company → 404, no write.
 *   - pending/removed → 409 with BankTransactionNotPostedError's message, no write.
 *   - posted → writes proceed, 200.
 *
 * Only the SQL layer is mocked — the real handler and the real
 * `readFeedState` (from bankFeedStateGuard) run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ kind: 'success', data })),
    notFound: vi.fn((_res: unknown, message: string) => ({ kind: 'notFound', message })),
    conflict: vi.fn((_res: unknown, message: string) => ({ kind: 'conflict', message })),
    validationError: vi.fn((_res: unknown, errors: unknown) => ({ kind: 'validationError', errors })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
  },
}));

import assetHandler from '../../../../pages/api/accounting/bank-match-asset';
import fleetHandler from '../../../../pages/api/accounting/bank-match-fleet';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const BANK_TX_ID = '00000000-0000-0000-0000-000000000002';
const ASSET_ID = '00000000-0000-0000-0000-000000000003';
const FLEET_ID = '00000000-0000-0000-0000-000000000004';

function req(body: Record<string, unknown>) {
  return { method: 'POST', companyId: COMPANY_ID, body } as never;
}

beforeEach(() => vi.clearAllMocks());

describe('bank-match-asset — pre-write feed_state read', () => {
  it('404s and writes nothing when the bank transaction does not exist for this company', async () => {
    sqlMock.mockResolvedValueOnce([]); // readFeedState finds nothing

    const out = await assetHandler(req({ bankTransactionId: BANK_TX_ID, assetId: ASSET_ID }), {} as NextApiResponse) as
      { kind: string };

    expect(out.kind).toBe('notFound');
    expect(sqlMock).toHaveBeenCalledTimes(1); // the read only — no asset/bank UPDATE
  });

  it('409s on a pending row and writes nothing', async () => {
    sqlMock.mockResolvedValueOnce([{ feed_state: 'pending' }]);

    const out = await assetHandler(req({ bankTransactionId: BANK_TX_ID, assetId: ASSET_ID }), {} as NextApiResponse) as
      { kind: string; message: string };

    expect(out.kind).toBe('conflict');
    expect(out.message).toMatch(/still pending at the bank/);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('proceeds to link on a posted row', async () => {
    sqlMock.mockResolvedValueOnce([{ feed_state: 'posted' }]); // readFeedState
    sqlMock.mockResolvedValue([]); // asset UPDATE, bank UPDATE

    const out = await assetHandler(req({ bankTransactionId: BANK_TX_ID, assetId: ASSET_ID }), {} as NextApiResponse) as
      { kind: string; data: { linked: boolean } };

    expect(out.kind).toBe('success');
    expect(out.data.linked).toBe(true);
    expect(sqlMock).toHaveBeenCalledTimes(3); // read + asset UPDATE + bank UPDATE
  });
});

describe('bank-match-fleet — pre-write feed_state read', () => {
  it('404s and writes nothing when the bank transaction does not exist for this company', async () => {
    sqlMock.mockResolvedValueOnce([]);

    const out = await fleetHandler(req({
      bankTransactionId: BANK_TX_ID, fleetEntityType: 'fuel', fleetEntityId: FLEET_ID,
    }), {} as NextApiResponse) as { kind: string };

    expect(out.kind).toBe('notFound');
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('409s on a removed row and writes nothing', async () => {
    sqlMock.mockResolvedValueOnce([{ feed_state: 'removed' }]);

    const out = await fleetHandler(req({
      bankTransactionId: BANK_TX_ID, fleetEntityType: 'service', fleetEntityId: FLEET_ID,
    }), {} as NextApiResponse) as { kind: string; message: string };

    expect(out.kind).toBe('conflict');
    expect(out.message).toMatch(/removed by the bank/);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('proceeds to link a fuel transaction on a posted row', async () => {
    sqlMock.mockResolvedValueOnce([{ feed_state: 'posted' }]);
    sqlMock.mockResolvedValue([]);

    const out = await fleetHandler(req({
      bankTransactionId: BANK_TX_ID, fleetEntityType: 'fuel', fleetEntityId: FLEET_ID,
    }), {} as NextApiResponse) as { kind: string; data: { linked: boolean } };

    expect(out.kind).toBe('success');
    expect(out.data.linked).toBe(true);
    expect(sqlMock).toHaveBeenCalledTimes(3);
  });
});
