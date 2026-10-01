import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn(async () => []));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { getGeneralLedgerLines } from '@/modules/accounting/services/gl/generalLedgerStreamService';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';
import { getAccountTransactions } from '@/modules/accounting/services/gl/accountTransactionsService';
import { getGeneralLedgerReport } from '@/modules/accounting/services/gl/generalLedgerReportService';

const C = '11111111-1111-4111-8111-111111111111';
const BAD = ['0001-01-01', '1899-12-31', '2201-01-01', '9999-12-31', ' 2026-01-01', '2026-1-1', '2026-02-31'];

const entries: Array<[string, (a: string, b: string) => Promise<unknown>]> = [
  ['getGeneralLedgerLines', (a, b) => getGeneralLedgerLines({ companyId: C, periodStart: a, periodEnd: b, limit: 10 })],
  ['getAccountLedger', (a, b) => getAccountLedger({ companyId: C, accountCode: '5200', fromDate: a, toDate: b })],
  ['getAccountTransactions', (a, b) => getAccountTransactions(C, '5200', a, b)],
  ['getGeneralLedgerReport', (a, b) => getGeneralLedgerReport(C, a, b)],
];

describe.each(entries)('%s refuses a non-ledger date before any SQL', (_n, call) => {
  beforeEach(() => { sqlMock.mockClear(); });
  it.each(BAD)('%s as start', async (bad) => {
    await expect(call(bad, '2026-09-30')).rejects.toThrow(/invalid ledger date/);
    expect(sqlMock).not.toHaveBeenCalled();
  }, 5000);
  it.each(BAD)('%s as end', async (bad) => {
    await expect(call('2026-01-01', bad)).rejects.toThrow(/invalid ledger date/);
    expect(sqlMock).not.toHaveBeenCalled();
  }, 5000);
});
