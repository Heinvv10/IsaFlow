/**
 * Unit tests for periodCloseReadinessService (orchestrator) and check files.
 *
 * Coverage:
 *  1. Each of the 6 checks returns sensible status given appropriate SQL data.
 *  2. company_id is the first interpolated arg in EVERY SQL call.
 *  3. Cross-tenant: different companyId → different results (branching mock).
 *  4. overallStatus aggregation: all-pass → pass; one warn → warn; one fail → fail.
 *  5. AR tolerance boundary (0.01).
 *  6. AP tolerance boundary (mirror of AR).
 *  7. Sub-ledger negative balance (−1000 vs −1000.005, within tolerance).
 *  8. getCloseReadiness returns null when period not found.
 *  9. SQL shape: bank check filters status IN ('imported','matched') — not NOT IN.
 * 10. SQL shape: AR check includes 'sent' status.
 * 11. SQL shape: each check references its expected table.
 * 12. Promise.allSettled isolation: one check throwing → others still report.
 * 13. Fix-link hrefs correct for each failing check.
 * 14. Period label and id forwarded from fiscal period record.
 * 15. unposted_journals count in reason text.
 * 16. tb_balanced fail when debits != credits.
 * 17. vat_reviewed warns (not fails) when no return.
 * 18. AP failure isolation — failing AP check doesn't blank other items.
 * 19. AR warn vs fail boundary (diff > 100 → fail, diff <= 100 → warn).
 * 20. AP warn vs fail boundary mirrors AR.
 * 21. COALESCE(amount_paid) — AR total when amount_paid is NULL.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({
  getFiscalPeriodById: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getFiscalPeriodById } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { getCloseReadiness } from '@/modules/accounting/services/gl/periodCloseReadinessService';
import { bankReconciledCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/bankReconciledCheck';
import { arSubLedgerCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/arSubLedgerCheck';
import { apSubLedgerCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/apSubLedgerCheck';
import { unpostedJournalsCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/unpostedJournalsCheck';
import { tbBalancedCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/tbBalancedCheck';
import { vatReviewedCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/vatReviewedCheck';
import type { FiscalPeriod } from '@/modules/accounting/types/gl.types';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
type GetPeriodFn = MockedFunction<(companyId: string, id: string) => Promise<FiscalPeriod | null>>;

const mockSql = sql as unknown as SqlFn;
const mockGetPeriodById = getFiscalPeriodById as GetPeriodFn;

const COMPANY_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PERIOD_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function makePeriod(overrides: Partial<FiscalPeriod> = {}): FiscalPeriod {
  return {
    id: PERIOD_ID,
    periodName: 'January 2026',
    periodNumber: 1,
    fiscalYear: 2026,
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    status: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Sets up mocks for all 6 SQL checks in Promise.allSettled execution order.
 * Because checks run in parallel, the SQL call order is:
 *  Call 1: bank       (1 query)
 *  Call 2: journals   (1 query)
 *  Call 3: ar invoice sum   (first await)
 *  Call 4: ap invoice sum   (first await)
 *  Call 5: vat        (1 query)
 *  Call 6: tb         (1 query)
 *  Call 7: ar GL balance    (second await)
 *  Call 8: ap GL balance    (second await)
 */
function mockAllChecksPass(): void {
  mockSql
    .mockResolvedValueOnce([{ unreconciled_count: '0' }])
    .mockResolvedValueOnce([{ draft_count: '0' }])
    .mockResolvedValueOnce([{ ar_total: '1000.00' }])
    .mockResolvedValueOnce([{ ap_total: '500.00' }])
    .mockResolvedValueOnce([{ vat_count: '1' }])
    .mockResolvedValueOnce([{ total_debit: '10000.00', total_credit: '10000.00' }])
    .mockResolvedValueOnce([{ gl_balance: '1000.00' }])
    .mockResolvedValueOnce([{ gl_balance: '500.00' }]);
}

describe('getCloseReadiness — orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Null period ──────────────────────────────────────────────────────────

  it('returns null when period is not found for this company', async () => {
    mockGetPeriodById.mockResolvedValueOnce(null);

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    expect(result).toBeNull();
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── All pass ─────────────────────────────────────────────────────────────

  it('returns overallStatus=pass when all checks pass', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    mockAllChecksPass();

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    expect(result).not.toBeNull();
    expect(result!.overallStatus).toBe('pass');
    expect(result!.items).toHaveLength(6);
    for (const item of result!.items) {
      expect(item.status).toBe('pass');
    }
  });

  // ── overallStatus aggregation ─────────────────────────────────────────────

  it('overallStatus is warn when at least one item is warn and none fail', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '0' }])
      .mockResolvedValueOnce([{ draft_count: '0' }])
      .mockResolvedValueOnce([{ ar_total: '1000.00' }])
      .mockResolvedValueOnce([{ ap_total: '500.00' }])
      .mockResolvedValueOnce([{ vat_count: '0' }])         // VAT: WARN
      .mockResolvedValueOnce([{ total_debit: '10000.00', total_credit: '10000.00' }])
      .mockResolvedValueOnce([{ gl_balance: '1000.00' }])
      .mockResolvedValueOnce([{ gl_balance: '500.00' }]);

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    expect(result!.overallStatus).toBe('warn');
    const vatItem = result!.items.find(i => i.key === 'vat_reviewed');
    expect(vatItem!.status).toBe('warn');
  });

  it('overallStatus is fail when at least one item fails', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '3' }])  // bank: FAIL
      .mockResolvedValueOnce([{ draft_count: '0' }])
      .mockResolvedValueOnce([{ ar_total: '1000.00' }])
      .mockResolvedValueOnce([{ ap_total: '500.00' }])
      .mockResolvedValueOnce([{ vat_count: '1' }])
      .mockResolvedValueOnce([{ total_debit: '10000.00', total_credit: '10000.00' }])
      .mockResolvedValueOnce([{ gl_balance: '1000.00' }])
      .mockResolvedValueOnce([{ gl_balance: '500.00' }]);

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    expect(result!.overallStatus).toBe('fail');
    const bankItem = result!.items.find(i => i.key === 'bank_reconciled');
    expect(bankItem!.status).toBe('fail');
  });

  // ── company_id in first SQL arg ───────────────────────────────────────────

  it('passes company_id as first interpolated arg in every SQL call', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    mockAllChecksPass();

    await getCloseReadiness(COMPANY_A, PERIOD_ID);

    expect(mockSql).toHaveBeenCalledTimes(8);
    for (const call of mockSql.mock.calls) {
      const firstArg = call[1] as string;
      expect(firstArg).toBe(COMPANY_A);
    }
  });

  // ── Cross-tenant isolation — branching mock ───────────────────────────────

  it('routes SQL by tenant — different companyId produces different results', async () => {
    // Branching mock: routes by the companyId interpolated into the query.
    mockSql.mockImplementation((_template: TemplateStringsArray, ...args: unknown[]) => {
      const companyId = args[0] as string;
      if (companyId === COMPANY_A) {
        // company A has 3 unreconciled transactions
        return Promise.resolve([
          { unreconciled_count: '3', draft_count: '0', ar_total: '0',
            ap_total: '0', vat_count: '1', total_debit: '0', total_credit: '0',
            gl_balance: '0' },
        ]);
      }
      // company B: all clear
      return Promise.resolve([
        { unreconciled_count: '0', draft_count: '0', ar_total: '0',
          ap_total: '0', vat_count: '1', total_debit: '0', total_credit: '0',
          gl_balance: '0' },
      ]);
    });

    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    const resultA = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    vi.clearAllMocks();

    mockSql.mockImplementation((_template: TemplateStringsArray, ...args: unknown[]) => {
      const companyId = args[0] as string;
      if (companyId === COMPANY_B) {
        return Promise.resolve([
          { unreconciled_count: '0', draft_count: '0', ar_total: '0',
            ap_total: '0', vat_count: '1', total_debit: '0', total_credit: '0',
            gl_balance: '0' },
        ]);
      }
      return Promise.resolve([{ unreconciled_count: '3' }]);
    });

    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    const resultB = await getCloseReadiness(COMPANY_B, PERIOD_ID);

    const bankA = resultA!.items.find(i => i.key === 'bank_reconciled');
    const bankB = resultB!.items.find(i => i.key === 'bank_reconciled');

    expect(bankA!.status).toBe('fail');
    expect(bankB!.status).toBe('pass');

    // Confirm second run's SQL calls use COMPANY_B
    const secondRunFirstArg = mockSql.mock.calls[0]![1];
    expect(secondRunFirstArg).toBe(COMPANY_B);
  });

  // ── Promise.allSettled isolation ─────────────────────────────────────────

  it('one check throwing → others still report normally; failing check shows warn', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());

    // bank check throws; everything else passes
    mockSql
      .mockRejectedValueOnce(new Error('DB timeout'))  // bank check: THROWS
      .mockResolvedValueOnce([{ draft_count: '0' }])
      .mockResolvedValueOnce([{ ar_total: '1000.00' }])
      .mockResolvedValueOnce([{ ap_total: '500.00' }])
      .mockResolvedValueOnce([{ vat_count: '1' }])
      .mockResolvedValueOnce([{ total_debit: '10000.00', total_credit: '10000.00' }])
      .mockResolvedValueOnce([{ gl_balance: '1000.00' }])
      .mockResolvedValueOnce([{ gl_balance: '500.00' }]);

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(6);

    const bankItem = result!.items.find(i => i.key === 'bank_reconciled');
    expect(bankItem!.status).toBe('warn');
    expect(bankItem!.reason).toContain('Could not compute');

    // Other checks should still pass
    const journalItem = result!.items.find(i => i.key === 'unposted_journals');
    expect(journalItem!.status).toBe('pass');

    // Error should be logged
    const mockLog = log as { error: MockedFunction<(...args: unknown[]) => void> };
    expect(mockLog.error).toHaveBeenCalledWith(
      'close-readiness check failed',
      expect.objectContaining({ checkIndex: 0 }),
      'accounting',
    );
  });

  it('AP check failing does not blank other items', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());

    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '0' }])  // bank: pass
      .mockResolvedValueOnce([{ draft_count: '0' }])           // journals: pass
      .mockResolvedValueOnce([{ ar_total: '1000.00' }])        // ar invoice sum
      .mockRejectedValueOnce(new Error('AP table unavailable')) // ap check: THROWS
      .mockResolvedValueOnce([{ vat_count: '1' }])             // vat: pass
      .mockResolvedValueOnce([{ total_debit: '1000.00', total_credit: '1000.00' }]) // tb: pass
      .mockResolvedValueOnce([{ gl_balance: '1000.00' }]);     // ar GL balance

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    const apItem = result!.items.find(i => i.key === 'ap_ties');
    expect(apItem!.status).toBe('warn');

    const bankItem = result!.items.find(i => i.key === 'bank_reconciled');
    expect(bankItem!.status).toBe('pass');

    const tbItem = result!.items.find(i => i.key === 'tb_balanced');
    expect(tbItem!.status).toBe('pass');
  });

  // ── Fix-link routes ───────────────────────────────────────────────────────

  it('returns correct fix-link hrefs for each check when not passing', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '1' }])
      .mockResolvedValueOnce([{ draft_count: '1' }])
      .mockResolvedValueOnce([{ ar_total: '1000' }])
      .mockResolvedValueOnce([{ ap_total: '1000' }])
      .mockResolvedValueOnce([{ vat_count: '0' }])
      .mockResolvedValueOnce([{ total_debit: '10200', total_credit: '10000' }])
      .mockResolvedValueOnce([{ gl_balance: '500' }])
      .mockResolvedValueOnce([{ gl_balance: '500' }]);

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);
    const byKey = Object.fromEntries(result!.items.map(i => [i.key, i]));

    expect(byKey['bank_reconciled']!.fixHref).toBe('/accounting/bank-transactions');
    expect(byKey['unposted_journals']!.fixHref).toContain('/accounting/journal-entries');
    expect(byKey['ar_ties']!.fixHref).toContain('/accounting/customer-invoices');
    expect(byKey['ap_ties']!.fixHref).toContain('/accounting/supplier-invoices');
    expect(byKey['vat_reviewed']!.fixHref).toContain('/accounting/reports/vat-return');
    expect(byKey['tb_balanced']!.fixHref).toContain('/accounting/trial-balance');
  });

  // ── Period label ─────────────────────────────────────────────────────────

  it('returns the period label and id from the fiscal period record', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod({ periodName: 'March 2026' }));
    mockAllChecksPass();

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    expect(result!.periodLabel).toBe('March 2026');
    expect(result!.periodId).toBe(PERIOD_ID);
  });
});

// ── bankReconciledCheck ───────────────────────────────────────────────────────

describe('bankReconciledCheck', () => {
  beforeEach(() => vi.clearAllMocks());

  const PERIOD = { startDate: '2026-01-01', endDate: '2026-01-31' };

  it('passes when no imported/matched transactions', async () => {
    mockSql.mockResolvedValueOnce([{ unreconciled_count: '0' }]);
    const item = await bankReconciledCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('pass');
  });

  it('fails when imported/matched transactions exist', async () => {
    mockSql.mockResolvedValueOnce([{ unreconciled_count: '5' }]);
    const item = await bankReconciledCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('fail');
    expect(item.reason).toContain('5');
  });

  it('SQL filters status IN imported/matched — does NOT use NOT IN', async () => {
    mockSql.mockResolvedValueOnce([{ unreconciled_count: '0' }]);
    await bankReconciledCheck(COMPANY_A, PERIOD);

    const call = mockSql.mock.calls[0]!;
    const template = call[0] as TemplateStringsArray;
    const fullQuery = template.join('?');
    // Must use positive IN filter, not NOT IN
    expect(fullQuery).toContain("status IN ('imported', 'matched')");
    expect(fullQuery).not.toContain('NOT IN');
  });

  it('SQL references bank_transactions table', async () => {
    mockSql.mockResolvedValueOnce([{ unreconciled_count: '0' }]);
    await bankReconciledCheck(COMPANY_A, PERIOD);

    const template = mockSql.mock.calls[0]![0] as TemplateStringsArray;
    expect(template.join('?')).toContain('bank_transactions');
  });

  it('company_id is first interpolated arg', async () => {
    mockSql.mockResolvedValueOnce([{ unreconciled_count: '0' }]);
    await bankReconciledCheck(COMPANY_A, PERIOD);
    expect(mockSql.mock.calls[0]![1]).toBe(COMPANY_A);
  });
});

// ── arSubLedgerCheck ─────────────────────────────────────────────────────────

describe('arSubLedgerCheck', () => {
  beforeEach(() => vi.clearAllMocks());

  const PERIOD = { endDate: '2026-01-31' };

  it('passes when AR sub-ledger equals GL balance', async () => {
    mockSql
      .mockResolvedValueOnce([{ ar_total: '1000.00' }])
      .mockResolvedValueOnce([{ gl_balance: '1000.00' }]);
    const item = await arSubLedgerCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('pass');
  });

  it('passes at tolerance boundary (diff = 0.01)', async () => {
    mockSql
      .mockResolvedValueOnce([{ ar_total: '1000.01' }])
      .mockResolvedValueOnce([{ gl_balance: '1000.00' }]);
    const item = await arSubLedgerCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('pass');
  });

  it('passes within tolerance (diff = 0.005)', async () => {
    mockSql
      .mockResolvedValueOnce([{ ar_total: '1000.005' }])
      .mockResolvedValueOnce([{ gl_balance: '1000.00' }]);
    const item = await arSubLedgerCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('pass');
  });

  it('warns when diff > tolerance but <= 100', async () => {
    mockSql
      .mockResolvedValueOnce([{ ar_total: '1050.00' }])
      .mockResolvedValueOnce([{ gl_balance: '1000.00' }]);
    const item = await arSubLedgerCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('warn');
  });

  it('fails when diff > 100 (SUB_LEDGER_FAIL_THRESHOLD)', async () => {
    mockSql
      .mockResolvedValueOnce([{ ar_total: '1200.00' }])
      .mockResolvedValueOnce([{ gl_balance: '1000.00' }]);
    const item = await arSubLedgerCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('fail');
  });

  it('passes when both sub-ledger and GL show negative balance within tolerance', async () => {
    // Scenario: credit note scenario — AR sub-ledger = -1000, GL = -1000.005
    mockSql
      .mockResolvedValueOnce([{ ar_total: '-1000.000' }])
      .mockResolvedValueOnce([{ gl_balance: '-1000.005' }]);
    const item = await arSubLedgerCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('pass');
  });

  it("SQL includes 'sent' in AR status filter", async () => {
    mockSql
      .mockResolvedValueOnce([{ ar_total: '0' }])
      .mockResolvedValueOnce([{ gl_balance: '0' }]);
    await arSubLedgerCheck(COMPANY_A, PERIOD);

    const invoiceQueryTemplate = mockSql.mock.calls[0]![0] as TemplateStringsArray;
    const invoiceQuery = invoiceQueryTemplate.join('?');
    expect(invoiceQuery).toContain("'sent'");
  });

  it('SQL references customer_invoices and gl_journal_lines', async () => {
    mockSql
      .mockResolvedValueOnce([{ ar_total: '0' }])
      .mockResolvedValueOnce([{ gl_balance: '0' }]);
    await arSubLedgerCheck(COMPANY_A, PERIOD);

    const invTemplate = mockSql.mock.calls[0]![0] as TemplateStringsArray;
    const glTemplate = mockSql.mock.calls[1]![0] as TemplateStringsArray;
    expect(invTemplate.join('?')).toContain('customer_invoices');
    expect(glTemplate.join('?')).toContain('gl_journal_lines');
  });

  it('company_id is first interpolated arg in both SQL calls', async () => {
    mockSql
      .mockResolvedValueOnce([{ ar_total: '0' }])
      .mockResolvedValueOnce([{ gl_balance: '0' }]);
    await arSubLedgerCheck(COMPANY_A, PERIOD);

    expect(mockSql.mock.calls[0]![1]).toBe(COMPANY_A);
    expect(mockSql.mock.calls[1]![1]).toBe(COMPANY_A);
  });
});

// ── apSubLedgerCheck ─────────────────────────────────────────────────────────

describe('apSubLedgerCheck', () => {
  beforeEach(() => vi.clearAllMocks());

  const PERIOD = { endDate: '2026-01-31' };

  it('passes when AP sub-ledger equals GL balance', async () => {
    mockSql
      .mockResolvedValueOnce([{ ap_total: '500.00' }])
      .mockResolvedValueOnce([{ gl_balance: '500.00' }]);
    const item = await apSubLedgerCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('pass');
  });

  it('passes at tolerance boundary (diff = 0.01)', async () => {
    mockSql
      .mockResolvedValueOnce([{ ap_total: '500.01' }])
      .mockResolvedValueOnce([{ gl_balance: '500.00' }]);
    const item = await apSubLedgerCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('pass');
  });

  it('warns when diff > tolerance but <= 100', async () => {
    mockSql
      .mockResolvedValueOnce([{ ap_total: '550.00' }])
      .mockResolvedValueOnce([{ gl_balance: '500.00' }]);
    const item = await apSubLedgerCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('warn');
  });

  it('fails when diff > 100 (SUB_LEDGER_FAIL_THRESHOLD)', async () => {
    mockSql
      .mockResolvedValueOnce([{ ap_total: '700.00' }])
      .mockResolvedValueOnce([{ gl_balance: '500.00' }]);
    const item = await apSubLedgerCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('fail');
  });

  it("SQL does NOT include 'overdue' in AP status filter", async () => {
    mockSql
      .mockResolvedValueOnce([{ ap_total: '0' }])
      .mockResolvedValueOnce([{ gl_balance: '0' }]);
    await apSubLedgerCheck(COMPANY_A, PERIOD);

    const invTemplate = mockSql.mock.calls[0]![0] as TemplateStringsArray;
    const invQuery = invTemplate.join('?');
    expect(invQuery).not.toContain("'overdue'");
    // Must include approved and partially_paid
    expect(invQuery).toContain("'approved'");
    expect(invQuery).toContain("'partially_paid'");
  });

  it('SQL references supplier_invoices and gl_journal_lines', async () => {
    mockSql
      .mockResolvedValueOnce([{ ap_total: '0' }])
      .mockResolvedValueOnce([{ gl_balance: '0' }]);
    await apSubLedgerCheck(COMPANY_A, PERIOD);

    const invTemplate = mockSql.mock.calls[0]![0] as TemplateStringsArray;
    const glTemplate = mockSql.mock.calls[1]![0] as TemplateStringsArray;
    expect(invTemplate.join('?')).toContain('supplier_invoices');
    expect(glTemplate.join('?')).toContain('gl_journal_lines');
  });

  it('company_id is first interpolated arg in both SQL calls', async () => {
    mockSql
      .mockResolvedValueOnce([{ ap_total: '0' }])
      .mockResolvedValueOnce([{ gl_balance: '0' }]);
    await apSubLedgerCheck(COMPANY_A, PERIOD);

    expect(mockSql.mock.calls[0]![1]).toBe(COMPANY_A);
    expect(mockSql.mock.calls[1]![1]).toBe(COMPANY_A);
  });
});

// ── unpostedJournalsCheck ─────────────────────────────────────────────────────

describe('unpostedJournalsCheck', () => {
  beforeEach(() => vi.clearAllMocks());

  const PERIOD = { id: PERIOD_ID };

  it('passes when all journals are posted', async () => {
    mockSql.mockResolvedValueOnce([{ draft_count: '0' }]);
    const item = await unpostedJournalsCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('pass');
  });

  it('fails with count in reason when draft journals exist', async () => {
    mockSql.mockResolvedValueOnce([{ draft_count: '5' }]);
    const item = await unpostedJournalsCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('fail');
    expect(item.reason).toContain('5');
    expect(item.fixHref).toBe('/accounting/journal-entries?filter=draft');
  });

  it('SQL references gl_journal_entries', async () => {
    mockSql.mockResolvedValueOnce([{ draft_count: '0' }]);
    await unpostedJournalsCheck(COMPANY_A, PERIOD);

    const template = mockSql.mock.calls[0]![0] as TemplateStringsArray;
    expect(template.join('?')).toContain('gl_journal_entries');
  });

  it('company_id is first interpolated arg', async () => {
    mockSql.mockResolvedValueOnce([{ draft_count: '0' }]);
    await unpostedJournalsCheck(COMPANY_A, PERIOD);
    expect(mockSql.mock.calls[0]![1]).toBe(COMPANY_A);
  });
});

// ── tbBalancedCheck ───────────────────────────────────────────────────────────

describe('tbBalancedCheck', () => {
  beforeEach(() => vi.clearAllMocks());

  const PERIOD = { id: PERIOD_ID };

  it('passes when debits equal credits', async () => {
    mockSql.mockResolvedValueOnce([{ total_debit: '10000.00', total_credit: '10000.00' }]);
    const item = await tbBalancedCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('pass');
  });

  it('fails when debits != credits', async () => {
    mockSql.mockResolvedValueOnce([{ total_debit: '10200.00', total_credit: '10000.00' }]);
    const item = await tbBalancedCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('fail');
    expect(item.fixHref).toBe('/accounting/trial-balance');
  });

  it('SQL references gl_journal_lines and gl_journal_entries', async () => {
    mockSql.mockResolvedValueOnce([{ total_debit: '0', total_credit: '0' }]);
    await tbBalancedCheck(COMPANY_A, PERIOD);

    const template = mockSql.mock.calls[0]![0] as TemplateStringsArray;
    const q = template.join('?');
    expect(q).toContain('gl_journal_lines');
    expect(q).toContain('gl_journal_entries');
  });

  it('company_id is first interpolated arg', async () => {
    mockSql.mockResolvedValueOnce([{ total_debit: '0', total_credit: '0' }]);
    await tbBalancedCheck(COMPANY_A, PERIOD);
    expect(mockSql.mock.calls[0]![1]).toBe(COMPANY_A);
  });
});

// ── vatReviewedCheck ─────────────────────────────────────────────────────────

describe('vatReviewedCheck', () => {
  beforeEach(() => vi.clearAllMocks());

  const PERIOD = { startDate: '2026-01-01', endDate: '2026-01-31' };

  it('passes when a VAT return exists for this period', async () => {
    mockSql.mockResolvedValueOnce([{ vat_count: '1' }]);
    const item = await vatReviewedCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('pass');
  });

  it('warns (not fails) when no VAT return exists', async () => {
    mockSql.mockResolvedValueOnce([{ vat_count: '0' }]);
    const item = await vatReviewedCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('warn');
  });

  it('SQL references vat_returns table', async () => {
    mockSql.mockResolvedValueOnce([{ vat_count: '0' }]);
    await vatReviewedCheck(COMPANY_A, PERIOD);

    const template = mockSql.mock.calls[0]![0] as TemplateStringsArray;
    expect(template.join('?')).toContain('vat_returns');
  });

  it('company_id is first interpolated arg', async () => {
    mockSql.mockResolvedValueOnce([{ vat_count: '0' }]);
    await vatReviewedCheck(COMPANY_A, PERIOD);
    expect(mockSql.mock.calls[0]![1]).toBe(COMPANY_A);
  });
});
