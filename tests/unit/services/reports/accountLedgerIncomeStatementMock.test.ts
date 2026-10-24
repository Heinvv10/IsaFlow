/**
 * getAccountLedger with an INCOME-STATEMENT account, SQL mocked (LED-01 / W2-04).
 *
 * accountLedgerService.test.ts only ever feeds asset/liability accounts, so the
 * fiscal-year floor and the year-end close row were invisible to it. This pins
 * them at the SQL-argument level: which floor date the opening query binds, that
 * a balance-sheet account binds none, a stored year winning over the template,
 * and the close row's placement. (Separate file: accountLedgerService.test.ts is already 592 lines.)
 * The Postgres-backed behaviour is in accountLedgerFiscalYearDb.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock, withTransaction: vi.fn() };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
// The floor is the registry year's start; each test sets the company's calendar (fakeRegistry).
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry',
  async () => (await import('../../../helpers/fiscalYearSqlFake')).registryMock());

import { sql } from '@/lib/neon';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';
import { fakeRegistry, resetFakeRegistry } from '../../../helpers/fiscalYearSqlFake';

/** A July-to-June company with no stored years: the registry hands back its template years. */
const julyCompany = (): void => { fakeRegistry.years = []; fakeRegistry.templateMonth = 7; };

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACCOUNT = 'cccccccc-1111-0000-0000-000000000001';
const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

function meta(accountType: string, normal: string) {
  return [{ id: ACCOUNT, account_code: '5200', account_name: 'Labour', account_type: accountType,
    normal_balance: normal }];
}
const txn = (date: string, debit: number) => ({ journal_entry_id: `je-${date}`, entry_date: date,
  entry_number: date, description: '', reference: '', source: 'manual', debit: String(debit), credit: '0' });

/** Interpolated values of the n-th sql call. */
const args = (n: number) => sqlMock.mock.calls[n]?.slice(1) ?? [];

async function readSeptember(accountType: string, normal: string) {
  sqlMock
    .mockResolvedValueOnce(meta(accountType, normal))
    .mockResolvedValueOnce([{ total_debit: '0', total_credit: '0' }])
    .mockResolvedValueOnce([{ total: '0' }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ period_debit: '0', period_credit: '0' }]);
  return getAccountLedger({ companyId: COMPANY, accountId: ACCOUNT, fromDate: '2025-09-01', toDate: '2025-09-30' });
}

beforeEach(() => { sqlMock.mockReset(); resetFakeRegistry(); });

describe('getAccountLedger — income-statement account (mocked SQL)', () => {
  it('floors an expense account opening at the registry year start (July)', async () => {
    julyCompany();
    await readSeptember('expense', 'debit');
    expect(args(1)).toContain('2025-07-01');
    expect(sqlMock).toHaveBeenCalledTimes(5); // no year-end close query inside one fiscal year
  });

  it('floors at a STORED year\'s own start, whatever month the template would use', async () => {
    fakeRegistry.years = [{ fiscalYear: 2026, startDate: '2025-04-01', endDate: '2026-03-31' }];
    fakeRegistry.templateMonth = 7;
    await readSeptember('revenue', 'credit');
    expect(args(1)).toContain('2025-04-01');
    expect(args(1)).not.toContain('2025-07-01');
  });

  it('binds no floor for a balance-sheet account', async () => {
    julyCompany();
    await readSeptember('asset', 'debit');
    expect(args(1)).not.toContain('2025-07-01');
    expect(args(1)).toContain(null);
  });

  it('places a derived close row at the FY end and resets the running balance', async () => {
    julyCompany();
    sqlMock
      .mockResolvedValueOnce(meta('expense', 'debit'))
      .mockResolvedValueOnce([{ total_debit: '0', total_credit: '0' }])  // opening (floor 2024-07-01)
      .mockResolvedValueOnce([{ total: '2' }])                           // line count
      .mockResolvedValueOnce([{ bucket: 0, d: '300', c: '0', n: '1' }]) // grouped: the year closing 2025-07-01
      .mockResolvedValueOnce([txn('2025-06-15', 300), txn('2025-08-01', 50)])
      .mockResolvedValueOnce([{ period_debit: '350', period_credit: '0' }]);

    const r = await getAccountLedger({ companyId: COMPANY, accountId: ACCOUNT, fromDate: '2025-06-01', toDate: '2025-09-30' });

    expect(args(3)).toContain('2025-07-01');
    expect(r.rows.map(x => [x.entryDate, x.debit, x.credit, x.runningBalance, x.derived ?? false])).toEqual([
      ['2025-06-15', 300, 0, 300, false],
      ['2025-06-30', 0, 300, 0, true],
      ['2025-08-01', 50, 0, 50, false],
    ]);
    expect(r).toMatchObject({ total: 3, derivedRows: 1, periodNet: 350, closedToRetainedEarnings: -300, periodClosingBalance: 50 });
  });
});
