/**
 * The approval gate's reading of the journal in force (payrollApprovalGate#readPostedJournal and the choice it feeds
 * the comparison), driven through `judgePayrollApproval` with a mocked `sql`:
 *   - the posted lines' `description` column is selected (it finds net pay's credit, so a bank role that moved since
 *     posting is not a recalculation). The mock hands a row `description` only when the query text selects
 *     `l.description`, so dropping the column from the SELECT goes red;
 *   - a run recalculated since the journal posted is compared on the lines AS POSTED (`asPosted`: a tag the tag tool
 *     changed since is read back from the first batch's old_cc1_id); a run not recalculated since, on the lines as
 *     they stand (`current`). Swapping the two goes red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalBuilder', () => ({ buildPayrollJournalPlan: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollApprovalRefusal', () => ({ approvalStatusRefusal: vi.fn(() => null) }));
vi.mock('@/modules/accounting/services/payroll/payrollRunRecalcGate', () => ({
  recalculateRequiredRefusal: vi.fn(async () => null), runLinesRefusal: vi.fn(async () => null),
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunDirectiveClaim', () => ({
  judgeRunDirectives: vi.fn(async () => null), unpaidLeaverDirectiveNotes: vi.fn(async () => []),
}));
vi.mock('@/modules/accounting/services/payroll/payrollYearToDateGate', () => ({ judgeYearToDate: vi.fn(async () => ({ blocker: null, advisories: [] })) }));
vi.mock('@/modules/accounting/services/payroll/payrollRunLines', () => ({
  findOverdrawnLines: vi.fn(async () => []),
  findLoanPaymentsOffPayslip: vi.fn(async () => ({ offPayslip: [], fringeNotRecorded: [] })),
  findWithheldLoanLines: vi.fn(async () => []),
  findFringeNotRecordedLines: vi.fn(async () => []),
}));
vi.mock('@/modules/accounting/services/payroll/payrollTerminationPaidCheck', () => ({ findTerminationsPaidElsewhere: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/payroll/payrollRecurringProRata', () => ({ runProRataBlocker: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalParts', () => ({ closedPeriodBlocker: vi.fn(async () => null) }));
const readJournalChain = vi.fn();
const runRecalculatedSince = vi.fn();
vi.mock('@/modules/accounting/services/payroll/payrollJournalChain', () => ({
  readJournalChain: (...a: unknown[]) => readJournalChain(...a),
  runRecalculatedSince: (...a: unknown[]) => runRecalculatedSince(...a),
}));

interface JournalRow {
  gl_account_id: string; account_code: string; debit: number; credit: number; cc1_id: string | null; description: string;
  retagged?: boolean; old_cc1_id?: string | null;
}
let journalRows: JournalRow[] = [];
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (!text.includes('dimension_tag_batch_lines')) return [];
    const selectsDescription = text.includes('l.description');
    return journalRows.map((r, i) => {
      const { description, ...rest } = r;
      return {
        entry_number: 'JE-1', status: 'posted', reversed_at: null, account_name: `Account ${r.account_code}`,
        retagged: false, old_cc1_id: null, tied: 1, line_id: `line-${i}`, ...rest,
        ...(selectsDescription ? { description } : {}),
      };
    });
  }),
}));

import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import { judgePayrollApproval } from '@/modules/accounting/services/payroll/payrollApprovalGate';

const CO = 'aaaaaaaa-0000-4000-8000-000000000001';
const RUN = 'bbbbbbbb-0000-4000-8000-000000000002';
const JE = 'cccccccc-0000-4000-8000-000000000003';
const LABOUR = 'acct-labour', PAYE = 'acct-paye', BANK_OLD = 'acct-bank-old', BANK_NOW = 'acct-bank-now';
const NET_PAY = 'Net pay — bank disbursement';

const planLine = (glAccountId: string, code: string, debit: number, credit: number, description: string, cc1Id: string | null = null) =>
  ({ glAccountId, accountCode: code, accountName: `Account ${code}`, debit, credit, description, inactiveAccount: false, cc1Id });
const posted = (glAccountId: string, code: string, debit: number, credit: number, description: string, cc1Id: string | null = null): JournalRow =>
  ({ gl_account_id: glAccountId, account_code: code, debit, credit, cc1_id: cc1Id, description });

function givenPlan(lines: ReturnType<typeof planLine>[], bySource?: unknown[]): void {
  vi.mocked(buildPayrollJournalPlan).mockResolvedValue({
    runId: RUN, status: 'approved', alreadyPostedJournalId: JE, entryDate: '2026-10-31', description: 'Payroll run 2026-10',
    blockers: [], advisories: [], lines, totals: {}, ...(bySource ? { labourBySourceCentre: bySource } : {}),
  } as never);
}

beforeEach(() => {
  vi.mocked(buildPayrollJournalPlan).mockReset();
  readJournalChain.mockReset();
  runRecalculatedSince.mockReset();
  readJournalChain.mockResolvedValue({
    journals: [{ id: JE, entryNumber: 'JE-1', entryDate: '2026-10-31', status: 'posted', description: 'Payroll run 2026-10' }],
    state: 'in_force', broken: false,
  });
  runRecalculatedSince.mockResolvedValue(false);
});

describe('judgePayrollApproval — the journal in force, as the gate reads it', () => {
  it('the bank role moved since posting: net pay is found by the description the SELECT returns, so the run is not "recalculated"', async () => {
    journalRows = [
      posted(LABOUR, '5200', 1000, 0, 'Payroll run 2026-10 — gross pay'),
      posted(PAYE, '2140', 0, 200, 'Payroll run 2026-10 — PAYE'),
      posted(BANK_OLD, '1110', 0, 800, NET_PAY),
    ];
    givenPlan([
      planLine(LABOUR, '5200', 1000, 0, 'Payroll run 2026-10 — gross pay'),
      planLine(PAYE, '2140', 0, 200, 'Payroll run 2026-10 — PAYE'),
      planLine(BANK_NOW, '1544331', 0, 800, NET_PAY),
    ]);
    const gate = await judgePayrollApproval(CO, RUN);
    expect(gate?.blocker).toBeNull();
    expect(gate?.posted?.journalEntryId).toBe(JE);
  });

  it('a changed net pay amount is still a difference once folded', async () => {
    journalRows = [
      posted(LABOUR, '5200', 1000, 0, 'gross'),
      posted(PAYE, '2140', 0, 200, 'paye'),
      posted(BANK_OLD, '1110', 0, 800, NET_PAY),
    ];
    givenPlan([
      planLine(LABOUR, '5200', 1000, 0, 'gross'),
      planLine(PAYE, '2140', 0, 150, 'paye'),
      planLine(BANK_NOW, '1544331', 0, 850, NET_PAY),
    ]);
    expect((await judgePayrollApproval(CO, RUN))?.blocker?.code).toBe('recalculated_after_posting');
  });

  it('recalculated since posting: compared on the lines AS POSTED (a tag changed since is read from the first batch)', async () => {
    runRecalculatedSince.mockResolvedValue(true);
    // Posted with CC1 "cc-posted", re-tagged to "cc-now" by the tag tool afterwards.
    journalRows = [
      { ...posted(LABOUR, '5200', 1000, 0, 'gross', 'cc-now'), retagged: true, old_cc1_id: 'cc-posted' },
      posted(PAYE, '2140', 0, 200, 'paye'),
      posted(BANK_OLD, '1110', 0, 800, NET_PAY),
    ];
    givenPlan(
      [planLine(LABOUR, '5200', 1000, 0, 'gross', 'cc-posted'), planLine(PAYE, '2140', 0, 200, 'paye'), planLine(BANK_NOW, '1544331', 0, 800, NET_PAY)],
      [{ glAccountId: LABOUR, centreId: 'cc-posted', taggable: true, debit: 1000 }],
    );
    expect((await judgePayrollApproval(CO, RUN))?.blocker).toBeNull();
  });

  it('not recalculated since posting: compared on the lines as they stand now, not as posted', async () => {
    runRecalculatedSince.mockResolvedValue(false);
    // A credit line re-tagged since posting: it no longer reads as the plan's untagged PAYE line.
    journalRows = [
      posted(LABOUR, '5200', 1000, 0, 'gross'),
      { ...posted(PAYE, '2140', 0, 200, 'paye', 'cc-now'), retagged: true, old_cc1_id: null },
      posted(BANK_OLD, '1110', 0, 800, NET_PAY),
    ];
    givenPlan([planLine(LABOUR, '5200', 1000, 0, 'gross'), planLine(PAYE, '2140', 0, 200, 'paye'), planLine(BANK_NOW, '1544331', 0, 800, NET_PAY)]);
    expect((await judgePayrollApproval(CO, RUN))?.blocker?.code).toBe('recalculated_after_posting');
  });
});
