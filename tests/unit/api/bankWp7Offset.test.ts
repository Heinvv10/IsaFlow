/**
 * WP7: bank-transactions list. An offset past MAX_BANK_TX_OFFSET is refused by the service before any query
 * (OffsetTooLargeError) and the route answers 400; bank_account_id / reconciliation_id must be UUIDs (400, not a cast 500).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BAD_IDS, UUID_A, callRoute } from '../helpers/apiRouteCall';

const sqlMock = vi.fn();
const listTx = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: Object.assign((...a: unknown[]) => sqlMock(...a), { unsafe: (s: string) => s }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({ getBankTransactions: (...a: unknown[]) => listTx(...a) }));

import routeHandler from '../../../pages/api/accounting/bank-transactions';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import { MAX_BANK_TX_OFFSET, OffsetTooLargeError } from '@/modules/accounting/services/bank/bankTxCursor';

describe('the service', () => {
  beforeEach(() => { sqlMock.mockReset().mockResolvedValue([]); });

  it('refuses an offset beyond the bound before touching the database', async () => {
    await expect(getBankTransactions('co', { offset: MAX_BANK_TX_OFFSET + 1 })).rejects.toBeInstanceOf(OffsetTooLargeError);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('allows the bound itself', async () => {
    await getBankTransactions('co', { offset: MAX_BANK_TX_OFFSET }).catch(() => undefined);
    expect(sqlMock).toHaveBeenCalled();
  });
});

describe('the route', () => {
  beforeEach(() => { listTx.mockReset().mockResolvedValue({ transactions: [], total: 0 }); });

  const route = async () => routeHandler;

  it('an offset past the bound is a 400', async () => {
    const h = await route();
    listTx.mockRejectedValue(new OffsetTooLargeError());
    const r = await callRoute(h, { query: { bank_account_id: UUID_A, offset: '999999999' } });
    expect(r.code).toBe(400);
  });

  it.each(BAD_IDS.flatMap((b) => [['bank_account_id', b], ['bankAccountId', b], ['reconciliation_id', b], ['reconciliationId', b]]))(
    '%s=%s is a 400 and the list is not read', async (key, bad) => {
      const r = await callRoute(await route(), { query: { [key as string]: bad } });
      expect(r.code).toBe(400);
      expect(listTx).not.toHaveBeenCalled();
    });

  it('UUIDs and no ids pass through', async () => {
    const h = await route();
    expect((await callRoute(h, { query: { bank_account_id: UUID_A, reconciliation_id: UUID_A } })).code).toBe(200);
    expect((await callRoute(h, { query: {} })).code).toBe(200);
    expect(listTx).toHaveBeenCalledTimes(2);
  });
});
