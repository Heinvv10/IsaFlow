// A management pack has no fiscal_year. Its period is its own month (afs_documents.period,
// 'YYYY-MM'), so the pre-export checks must read the ledger up to the last day of THAT month
// instead of refusing with "Reporting period known".
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/afs/afsFiscalPeriod', () => ({ getFiscalRange: vi.fn() }));

import { sql } from '@/lib/neon';
import { getFiscalRange } from '@/modules/accounting/services/afs/afsFiscalPeriod';
import { packPeriodEnd } from '@/modules/accounting/services/afs/afsPackPeriod';
import { runPreExportChecks } from '@/modules/accounting/services/afs/afsPreExportChecks';

const CO = '83d9db71-788a-47c9-8f54-418cfabb768d';
const DOC = 'ba60eeb5-15bd-4e68-ae21-4bbe88005423';
const sqlMock = vi.mocked(sql) as unknown as ReturnType<typeof vi.fn>;

interface DocRow { fiscal_year: number | null; document_type: string; period: string | null }

/** Answer the document read, give the cash flow section a closing cash, and record every call. */
function stubDb(doc: DocRow) {
  sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('FROM   afs_documents')) return [doc];
    if (text.includes("section_type = 'cash_flow'")) return [{ data_snapshot: { closingCash: 100 } }];
    if (text.includes('SUM(jl.debit - jl.credit)::numeric') || text.includes('SUM(jl.debit - jl.credit)')) {
      return [{ balance: 100 }];
    }
    return [];
  });
}

/**
 * The rows a generated management pack actually has: sections keyed 'balance_sheet' and
 * 'cash_flow' whose snapshots hold the month's income figures (no statement totals, no
 * closing cash), no 'statement_of_fp', and no note sections, while a mandatory note template exists.
 */
function stubGeneratedPack(doc: DocRow) {
  const income = { revenue: 1000, cogs: 400, net_profit: 300 };
  sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('FROM   afs_documents')) return [doc];
    if (text.includes('FROM   note_templates')) return [{ section_type: 'accounting_policies' }];
    if (text.includes("section_type = 'cash_flow'")) return [{ data_snapshot: income }];
    if (text.includes("status      != 'pending'")) {
      return [{ section_type: 'balance_sheet' }, { section_type: 'cash_flow' }];
    }
    if (text.includes('SUM(jl.debit - jl.credit)')) return [{ balance: 100 }];
    return [];
  });
}

/** The entry_date cut-off the closing-cash ledger query was given. */
function ledgerCutoff(): string | undefined {
  const call = sqlMock.mock.calls.find(
    (c) => (c[0] as TemplateStringsArray).join('?').includes('je.entry_date <= ?::date')
      && (c[0] as TemplateStringsArray).join('?').includes('account_subtype'),
  );
  return call?.slice(1).find((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) as string | undefined;
}

beforeEach(() => {
  sqlMock.mockReset();
  vi.mocked(getFiscalRange).mockReset();
});

describe('packPeriodEnd', () => {
  it('is the last day of a 31-day month', () => {
    expect(packPeriodEnd('2026-08')).toBe('2026-08-31');
    expect(packPeriodEnd('2026-12')).toBe('2026-12-31');
  });
  it('is the 28th for February in a common year and the 29th in a leap year', () => {
    expect(packPeriodEnd('2026-02')).toBe('2026-02-28');
    expect(packPeriodEnd('2028-02')).toBe('2028-02-29');
  });
  it('is the 30th for a 30-day month', () => {
    expect(packPeriodEnd('2026-09')).toBe('2026-09-30');
  });
  it('is null for a missing or malformed period', () => {
    for (const bad of [null, undefined, '', '2026', '2026-13', '2026-00', '2026-8', 'Aug 2026', '2026-08-01']) {
      expect(packPeriodEnd(bad)).toBeNull();
    }
  });
});

describe('runPreExportChecks for a management pack', () => {
  it('does not return the Reporting period known blocker and runs the other checks', async () => {
    stubDb({ fiscal_year: null, document_type: 'management_pack', period: '2026-08' });
    const checks = await runPreExportChecks(DOC, CO, 'ifrs_smes');
    expect(checks.some((c) => c.label === 'Reporting period known')).toBe(false);
    expect(checks.length).toBeGreaterThan(1);
    expect(getFiscalRange).not.toHaveBeenCalled();
  });

  it('passes every blocker for a generated pack, which has no AFS statement sections or notes', async () => {
    stubGeneratedPack({ fiscal_year: null, document_type: 'management_pack', period: '2026-08' });
    const checks = await runPreExportChecks(DOC, CO, 'ifrs_smes');
    const failedBlockers = checks.filter((c) => c.severity === 'blocker' && !c.passed);
    expect(failedBlockers).toEqual([]);
    for (const label of ['Balance sheet balances', 'Closing cash agrees with the ledger', 'All mandatory notes present']) {
      expect(checks.find((c) => c.label === label)).toMatchObject({
        passed: true, detail: 'Not applicable to a management pack.',
      });
    }
  });

  it.each([null, '', '2026', '2026-13', 'Aug 2026'])(
    'blocks with its own readable wording when the pack period is %j',
    async (period) => {
      stubDb({ fiscal_year: null, document_type: 'management_pack', period });
      const checks = await runPreExportChecks(DOC, CO, 'ifrs_smes');
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ label: 'Reporting period known', passed: false, severity: 'blocker' });
      expect(checks[0]!.detail).toMatch(/management pack/i);
      expect(checks[0]!.detail).not.toMatch(/fiscal year/i);
    },
  );
});

describe('runPreExportChecks for annual financial statements', () => {
  it('still blocks a document with no fiscal year, ignoring any period', async () => {
    stubDb({ fiscal_year: null, document_type: 'afs', period: '2026-08' });
    const checks = await runPreExportChecks(DOC, CO, 'ifrs_smes');
    expect(checks).toHaveLength(1);
    expect(checks[0]!.detail).toMatch(/no fiscal year/);
  });

  it('still runs the statement blockers, which fail on sections that are not AFS statements', async () => {
    stubGeneratedPack({ fiscal_year: 2027, document_type: 'afs', period: null });
    vi.mocked(getFiscalRange).mockResolvedValue({ start: '2026-03-01', end: '2027-02-28' } as never);
    const checks = await runPreExportChecks(DOC, CO, 'ifrs_smes');
    const failed = checks.filter((c) => c.severity === 'blocker' && !c.passed).map((c) => c.label);
    expect(failed).toEqual(expect.arrayContaining([
      'Balance sheet balances', 'Closing cash agrees with the ledger', 'All mandatory notes present',
    ]));
  });

  it('still takes the period end from the financial year registry', async () => {
    stubDb({ fiscal_year: 2027, document_type: 'afs', period: null });
    vi.mocked(getFiscalRange).mockResolvedValue({ start: '2026-03-01', end: '2027-02-28' } as never);
    await runPreExportChecks(DOC, CO, 'ifrs_smes');
    expect(getFiscalRange).toHaveBeenCalledWith(CO, 2027);
    expect(ledgerCutoff()).toBe('2027-02-28');
  });
});
