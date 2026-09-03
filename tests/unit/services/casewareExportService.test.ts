/**
 * INV-E1: `exportCaseWareTB` used to export the range's gross debit and credit
 * TURNOVER for every account, so a client's audit software received one
 * period's movement labelled as a trial balance — Brightsphere's Trade Debtors
 * exported as R128,800 against a balance of R8,551,948.60. It now exports
 * balances: balance-sheet accounts cumulative to periodEnd, income-statement
 * accounts over the range, plus the pre-range profit on retained earnings.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock, withTransaction: vi.fn(), transaction: vi.fn(), fmtDate: (d: unknown) => String(d) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
import { sql } from '@/lib/neon';
import { exportCaseWareTB } from '@/modules/accounting/services/reports/casewareExportService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const PERIOD_START = '2025-03-01';
const PERIOD_END = '2026-01-31';

type SqlMock = ReturnType<typeof vi.fn>;

/**
 * SQL text of the Nth `sql` tagged-template call, with SQL comments stripped.
 *
 * Asserting on raw template text is one edit away from a false pass: a
 * `-- no longer filtered by fiscal_period_id` comment satisfies a
 * `toContain('fiscal_period_id')` without the filter existing, and breaks a
 * `not.toContain` without the filter returning. Strip comments and the
 * assertion is about the query the database actually runs.
 */
function sqlTextOf(mockSql: SqlMock, callIndex: number): string {
  const strings = (mockSql.mock.calls[callIndex] as unknown[])[0] as string[];
  return strings
    .join(' ? ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    ga_id: 'acc-1',
    AccountCode: '1101',
    AccountName: 'Trade Debtors Control',
    debit: '10370122.60',
    credit: '1818174.00',
    CaseWareCode: 'B20',
    CaseWareLabel: 'Trade receivables',
    ...overrides,
  };
}

function primeSql(rows: Record<string, unknown>[], broughtForward = '0') {
  const mockSql = sql as SqlMock;
  mockSql.mockResolvedValueOnce(rows).mockResolvedValueOnce([{ retained: broughtForward }]);
  return mockSql;
}

/** Parse the CSV back into records so assertions read as data, not string matching. */
function parse(csv: string): Array<Record<string, string>> {
  const [header, ...body] = csv.split('\r\n');
  const cols = header!.split(',');
  return body.filter(Boolean).map(line => {
    const cells = line.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('exportCaseWareTB (INV-E1 — balances, not period turnover)', () => {
  it('exports the cumulative trade debtors balance, not the range movement', async () => {
    primeSql([makeRow()]);
    const rows = parse(await exportCaseWareTB(COMPANY_ID, PERIOD_START, PERIOD_END));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.AccountCode).toBe('1101');
    expect(rows[0]!.Debit).toBe('8551948.60');
    expect(rows[0]!.Credit).toBe('0.00');
    expect(rows[0]!.NetBalance).toBe('8551948.60');
    // The old, wrong figure — the range's net turnover.
    expect(rows[0]!.Debit).not.toBe('128800.00');
  });

  it('bounds the query by periodEnd and exempts balance-sheet accounts from periodStart', async () => {
    const mockSql = primeSql([makeRow()]);
    await exportCaseWareTB(COMPANY_ID, PERIOD_START, PERIOD_END);

    const params = (mockSql.mock.calls[0] as unknown[]).slice(1);
    expect(params).toContain(PERIOD_START);
    expect(params).toContain(PERIOD_END);

    const text = sqlTextOf(mockSql, 0);
    expect(text).toContain("ga.account_type IN ('asset', 'liability', 'equity')");
    expect(text).toContain('gje.entry_date <=');
    // The date window must not sit inside the LEFT JOIN as a BETWEEN any more —
    // that made every account a range-movement figure.
    expect(text).not.toContain('BETWEEN');
  });

  it('reports a credit-balance account in the Credit column with a negative net', async () => {
    primeSql([makeRow({ AccountCode: '2001', AccountName: 'Trade Creditors', debit: '0', credit: '613641.77' })]);
    const rows = parse(await exportCaseWareTB(COMPANY_ID, PERIOD_START, PERIOD_END));
    expect(rows[0]!.Debit).toBe('0.00');
    expect(rows[0]!.Credit).toBe('613641.77');
    expect(rows[0]!.NetBalance).toBe('-613641.77');
  });

  it('omits accounts whose balance is zero', async () => {
    primeSql([makeRow({ debit: '25000', credit: '25000' }), makeRow({ AccountCode: '9999', debit: '0', credit: '0' })]);
    expect(parse(await exportCaseWareTB(COMPANY_ID, PERIOD_START, PERIOD_END))).toHaveLength(0);
  });

  it('adds the pre-range profit to retained earnings so the export balances', async () => {
    primeSql(
      [
        makeRow({ AccountCode: '1101', debit: '2254813.96', credit: '0' }),
      ],
      '2254813.96',
    );
    const rows = parse(await exportCaseWareTB(COMPANY_ID, PERIOD_START, PERIOD_END));

    const re = rows.find(r => r.AccountCode === 'RE-BF');
    expect(re).toBeDefined();
    expect(re!.Credit).toBe('2254813.96');
    // Still classifies as retained earnings on import...
    expect(re!.CaseWareCode).toBe('D20');
    // ...but the auditor importing this can see the figure was computed.
    expect(re!.AccountName).toContain('derived');
    expect(re!.AccountName).toContain('not posted');
    // The label must survive a naive comma-split importer.
    expect(re!.AccountName).not.toContain(',');

    const totalDebit = rows.reduce((s, r) => s + Number(r.Debit), 0);
    const totalCredit = rows.reduce((s, r) => s + Number(r.Credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 2);
  });

  it('leaves a posted retained earnings account carrying only its posted balance', async () => {
    primeSql([makeRow({ AccountCode: 'SYS11', AccountName: 'Retained Income', debit: '0', credit: '1000000.00' })], '2254813.96');
    const rows = parse(await exportCaseWareTB(COMPANY_ID, PERIOD_START, PERIOD_END));
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.AccountCode === 'SYS11')!.Credit).toBe('1000000.00');
    expect(rows.find(r => r.AccountCode === 'RE-BF')!.Credit).toBe('2254813.96');
  });

  it('asks for the brought-forward profit strictly before periodStart', async () => {
    const mockSql = primeSql([makeRow()], '100');
    await exportCaseWareTB(COMPANY_ID, PERIOD_START, PERIOD_END);
    const params = (mockSql.mock.calls[1] as unknown[]).slice(1);
    expect(params).toContain(PERIOD_START);
  });

  it('includes deactivated accounts that still carry a balance', async () => {
    // is_active marks an account closed for new postings, not empty. Filtering
    // on it dropped Brightsphere's R130,000 inactive loan account and left the
    // export out of balance by exactly that amount.
    const mockSql = primeSql([makeRow()]);
    await exportCaseWareTB(COMPANY_ID, PERIOD_START, PERIOD_END);
    const text = sqlTextOf(mockSql, 0);
    expect(text).not.toContain('ga.is_active');
  });

  it('keeps the CaseWare CSV header contract', async () => {
    primeSql([makeRow()]);
    const csv = await exportCaseWareTB(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(csv.split('\r\n')[0]).toBe('AccountCode,AccountName,Debit,Credit,NetBalance,CaseWareCode,CaseWareLabel');
  });
});
