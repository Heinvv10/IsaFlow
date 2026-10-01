import { describe, it, expect, vi, beforeEach } from 'vitest';

const logMock = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }));
const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: logMock }));

import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';
import { getAccountTransactions } from '@/modules/accounting/services/gl/accountTransactionsService';
import { LedgerAccountNotFoundError } from '@/modules/accounting/services/gl/ledgerErrors';

const C = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { Object.values(logMock).forEach(m => m.mockClear()); sqlMock.mockReset(); });

describe('an unknown account is an expected refusal, not an error event', () => {
  it.each([
    ['getAccountLedger', () => getAccountLedger({ companyId: C, accountCode: 'nope', fromDate: '2026-01-01', toDate: '2026-09-30' })],
    ['getAccountTransactions', () => getAccountTransactions(C, 'nope', '2026-01-01', '2026-09-30')],
  ])('%s: warns, does not log.error', async (_n, run) => {
    sqlMock.mockResolvedValue([]);
    await expect(run()).rejects.toBeInstanceOf(LedgerAccountNotFoundError);
    expect(logMock.error).not.toHaveBeenCalled();
    expect(logMock.warn).toHaveBeenCalledTimes(1);
  }, 5000);

  it('an unexpected failure still logs an error', async () => {
    sqlMock.mockRejectedValue(new Error('db down'));
    await expect(getAccountLedger({ companyId: C, accountCode: '5000', fromDate: '2026-01-01', toDate: '2026-09-30' })).rejects.toThrow('db down');
    expect(logMock.error).toHaveBeenCalledTimes(1);
  }, 5000);
});
