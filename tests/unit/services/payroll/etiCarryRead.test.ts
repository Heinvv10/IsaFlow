/**
 * The ETI carry's one monthly sum (wave 5 ET review round 2, rev L3 / adv M2): which runs a month counts.
 *  - 'declarable': approved and paid headers, as the EMP201 declares;
 *  - 'inForceJournal': only a run whose journal is in force (a directive's ETI journal books around it).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: (text: string) => ({ unsafe: text }) }) }));
vi.mock('@/modules/accounting/services/payroll/directivePaymentFiling', () => ({ listStandaloneDirectivePayments: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalChain', () => ({ payrollJournalInForce: vi.fn(async (_c: string, id: string) => id === 'je-live') }));

import { sql } from '@/lib/neon';
import { payRunFinalSql } from '@/modules/accounting/services/payroll/payRunFinalSql';
import { loadEtiMonths } from '@/modules/accounting/services/payroll/etiCarryRead';

const CO = '11111111-1111-1111-1111-111111111111';
const may = { year: 2026, month: 5 };
const rows = [
  // `final` is what the spliced payRunFinalSql fragment answers (wave 6 EF): approved/paid WITH an approval time.
  { period_year: 2026, period_month: 5, paye: 100, eti: 10, status: 'approved', journal_entry_id: 'je-reversed', final: true },
  { period_year: 2026, period_month: 5, paye: 200, eti: 20, status: 'paid', journal_entry_id: 'je-live', final: true },
  { period_year: 2026, period_month: 5, paye: 400, eti: 40, status: 'calculated', journal_entry_id: null, final: false },
  { period_year: 2026, period_month: 5, paye: 800, eti: 80, status: 'draft', journal_entry_id: null, final: false },
  { period_year: 2026, period_month: 5, paye: 1600, eti: 160, status: 'approved', journal_entry_id: null, final: false },
];

beforeEach(() => { vi.clearAllMocks(); vi.mocked(sql).mockResolvedValue(rows as never); });

describe('loadEtiMonths', () => {
  it('declarable: final runs only (an approved run with no approval time is out); rev3 L1 NAMED LIMIT: an approved run whose journal is NOT in force still counts (the EMP201 declares it)', async () => {
    expect((await loadEtiMonths(CO, may, may)).map((m) => m.paye)).toEqual([100, 200]);
  });
  it('inForceJournal: only the run whose journal is in force', async () => {
    expect((await loadEtiMonths(CO, may, may, 'inForceJournal')).map((m) => m.paye)).toEqual([200]);
  });
  it('none: no runs (and no read of them)', async () => {
    expect(await loadEtiMonths(CO, may, may, 'none')).toEqual([]);
    expect(sql).not.toHaveBeenCalled();
  });
  it("reads this company's headers for the range", async () => {
    await loadEtiMonths(CO, { year: 2026, month: 3 }, may);
    expect(vi.mocked(sql).mock.calls[0]!.slice(1).filter((v) => typeof v === 'string')).toEqual([CO, '2026-03-01', '2026-05-01']);
    expect(vi.mocked(sql).mock.calls[0]!.slice(1)).toContainEqual({ unsafe: payRunFinalSql('payroll_run_headers') });
  });
});
