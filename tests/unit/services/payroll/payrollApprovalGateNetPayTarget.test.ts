/**
 * The approval gate's handling of net pay's TARGET, driven through the real `judgePayrollApproval` with a mocked posted-
 * journal read (the pure pieces are in payrollFoldNetPayTarget.test.ts, which composes them by hand; this is the gate's
 * own wiring).
 *
 *  - a journal IN FORCE whose net pay went to the bank, run now on a clearing plan (and the reverse, and clearing A to B)
 *    is `net_pay_target_changed`, not a silent re-lock: deleting the gate's `if (moved) return moved;`, moving it after
 *    the fold, or handing it the wrong side's lines goes red;
 *  - the same bank role merely moved still re-locks;
 *  - an old journal with no net-pay descriptions against a clearing plan ends as `recalculated_after_posting` (a refusal:
 *    nothing re-locks, the cause is named less precisely) - asserted here as the final decision, not as a helper's `false`;
 *  - a journal that is REPLACED (reversed) after the setting moved carries the advisory `net_pay_target_replaced`, which
 *    names both accounts and says the cash leg stays; it never blocks.
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

interface JournalRow { gl_account_id: string; account_code: string; account_name: string; debit: number; credit: number; description: string | null }
let journalRows: JournalRow[] = [];
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (!text.includes('dimension_tag_batch_lines')) return [];
    return journalRows.map((r, i) => ({
      entry_number: 'JE-1', status: 'posted', reversed_at: null, retagged: false, old_cc1_id: null, tied: 1, line_id: `line-${i}`, cc1_id: null, ...r,
    }));
  }),
}));

import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import { judgePayrollApproval } from '@/modules/accounting/services/payroll/payrollApprovalGate';
import { NET_PAY_CLEARING_DESCRIPTION, NET_PAY_DESCRIPTION } from '@/modules/accounting/services/payroll/payrollLabourComparison';

const CO = 'aaaaaaaa-0000-4000-8000-000000000001';
const RUN = 'bbbbbbbb-0000-4000-8000-000000000002';
const JE = 'cccccccc-0000-4000-8000-000000000003';
const LABOUR = 'acct-labour', PAYE = 'acct-paye', BANK = 'acct-bank-1110', BANK_NEW = 'acct-bank-new', C2170 = 'acct-2170', C2171 = 'acct-2171';
const NAMES: Record<string, [string, string]> = {
  [LABOUR]: ['5200', 'Labour'], [PAYE]: ['2140', 'PAYE'], [BANK]: ['1110', 'Bank - Primary'], [BANK_NEW]: ['1544331', 'New Bank'],
  [C2170]: ['2170', 'Net Salaries Payable'], [C2171]: ['2171', 'Net Salaries Payable 2'],
};
type Target = { account: string | null; description: string };
const bank = (account: string | null = BANK): Target => ({ account, description: NET_PAY_DESCRIPTION });
const clearing = (account: string | null = C2170): Target => ({ account, description: NET_PAY_CLEARING_DESCRIPTION });

const planOf = (t: Target, net = 800) => [
  { glAccountId: LABOUR, accountCode: '5200', accountName: 'Labour', debit: 1000, credit: 0, description: 'gross', inactiveAccount: false, cc1Id: null },
  { glAccountId: PAYE, accountCode: '2140', accountName: 'PAYE', debit: 0, credit: 200, description: 'paye', inactiveAccount: false, cc1Id: null },
  { glAccountId: t.account, accountCode: t.account ? NAMES[t.account]![0] : '', accountName: t.account ? NAMES[t.account]![1] : '', debit: 0, credit: net, description: t.description, inactiveAccount: false, cc1Id: null },
];
const journalOf = (t: Target, net = 800, netDescription: string | null = t.description): JournalRow[] => [
  { gl_account_id: LABOUR, account_code: '5200', account_name: 'Labour', debit: 1000, credit: 0, description: 'gross' },
  { gl_account_id: PAYE, account_code: '2140', account_name: 'PAYE', debit: 0, credit: 200, description: 'paye' },
  { gl_account_id: t.account as string, account_code: NAMES[t.account!]![0], account_name: NAMES[t.account!]![1], debit: 0, credit: net, description: netDescription },
];

function given(was: Target, now: Target, over: { state?: 'in_force' | 'out'; recalculated?: boolean; netDescription?: string | null; blockers?: Array<{ code: string; detail: string }> } = {}): void {
  journalRows = journalOf(was, 800, over.netDescription === undefined ? was.description : over.netDescription);
  vi.mocked(buildPayrollJournalPlan).mockResolvedValue({
    runId: RUN, status: 'approved', alreadyPostedJournalId: JE, entryDate: '2026-10-31', description: 'Payroll run 2026-10',
    blockers: over.blockers ?? [], advisories: [], lines: planOf(now), totals: {},
  } as never);
  const head = { id: JE, entryNumber: 'JE-1', entryDate: '2026-10-31', status: 'posted', description: 'Payroll run 2026-10' };
  readJournalChain.mockResolvedValue(over.state === 'out'
    ? { journals: [head, { ...head, id: 'rev', entryNumber: 'JE-2' }], state: 'out', broken: false }
    : { journals: [head], state: 'in_force', broken: false });
  runRecalculatedSince.mockResolvedValue(over.recalculated === true);
}

beforeEach(() => {
  vi.mocked(buildPayrollJournalPlan).mockReset();
  readJournalChain.mockReset();
  runRecalculatedSince.mockReset();
});

describe.each([[false], [true]])('a journal in force, net pay target moved (run recalculated since posting: %s)', (recalculated) => {
  it('bank journal, clearing plan: net_pay_target_changed, not a re-lock', async () => {
    given(bank(), clearing(), { recalculated });
    const gate = await judgePayrollApproval(CO, RUN);
    expect(gate?.blocker?.code).toBe('net_pay_target_changed');
    expect(gate?.posted?.journalEntryId).toBe(JE);
  });

  it('clearing journal, bank plan: net_pay_target_changed', async () => {
    given(clearing(), bank(), { recalculated });
    expect((await judgePayrollApproval(CO, RUN))?.blocker?.code).toBe('net_pay_target_changed');
  });

  it('clearing journal, another clearing account: net_pay_target_changed', async () => {
    given(clearing(C2170), clearing(C2171), { recalculated });
    expect((await judgePayrollApproval(CO, RUN))?.blocker?.code).toBe('net_pay_target_changed');
  });

  it('clearing journal, same clearing account: re-locks (no blocker)', async () => {
    given(clearing(), clearing(), { recalculated });
    expect((await judgePayrollApproval(CO, RUN))?.blocker).toBeNull();
  });

  it('bank journal, the bank role merely moved: still re-locks', async () => {
    given(bank(BANK), bank(BANK_NEW), { recalculated });
    expect((await judgePayrollApproval(CO, RUN))?.blocker).toBeNull();
  });
});

describe.each([[false], [true]])('a clearing plan whose account no longer resolves (recalculated since posting: %s)', (recalculated) => {
  const dangling = [{ code: 'missing_net_pay_account', detail: 'The account set for Payroll net pay no longer exists. Choose another account.' }];

  it.each([['a bank journal', bank()], ['a clearing journal', clearing()]])(
    'against %s, the plan\'s own net-pay blocker is shown, not net_pay_target_changed and not "recalculated"', async (_n, was) => {
      given(was, clearing(null), { recalculated, blockers: [{ code: 'missing_gl_accounts', detail: 'x' }, ...dangling] });
      const gate = await judgePayrollApproval(CO, RUN);
      expect(gate?.blocker).toEqual(dangling[0]);
    });

  it('a BANK plan with no holder still re-locks onto its bank journal (the bank role is one role on both sides)', async () => {
    given(bank(), bank(null), { recalculated, blockers: [{ code: 'missing_bank_account', detail: 'no bank' }] });
    expect((await judgePayrollApproval(CO, RUN))?.blocker).toBeNull();
  });
});

describe('the refusal text', () => {
  it('names both accounts, the way to keep the journal, and that reversing re-posts to the setting at that time', async () => {
    given(bank(), clearing());
    const detail = String((await judgePayrollApproval(CO, RUN))?.blocker?.detail);
    expect(detail).toContain('1110 Bank - Primary');
    expect(detail).toContain('2170 Net Salaries Payable');
    expect(detail).toMatch(/set Payroll net pay in Default Accounts back/);
    expect(detail).toMatch(/reverse journal JE-1: approving then posts a new journal to the account the setting names at that time \(.*2170/);
    expect(detail).toMatch(/cash that paid it stays booked there/);
    expect(detail).not.toMatch(/Reverse journal JE-1 first/);
  });
});

describe('an old journal whose lines carry no net-pay description (L4)', () => {
  it('against a clearing plan the FINAL decision is recalculated_after_posting: a refusal, never a re-lock', async () => {
    // Posted before descriptions were written, or hand-keyed: neither note can recognise its net-pay line.
    given(bank(), clearing(), { netDescription: null });
    const gate = await judgePayrollApproval(CO, RUN);
    expect(gate?.blocker?.code).toBe('recalculated_after_posting');
    expect(gate?.posted?.journalEntryId).toBe(JE);
  });

  it('against a bank plan on the same bank account it still re-locks (unchanged behaviour)', async () => {
    given(bank(), bank(), { netDescription: null });
    expect((await judgePayrollApproval(CO, RUN))?.blocker).toBeNull();
  });
});

describe('a journal replaced after the setting moved: the advisory (decision 2)', () => {
  const advisory = async () => {
    const gate = await judgePayrollApproval(CO, RUN);
    return { gate, note: gate?.plan.advisories.find((a) => a.code === 'net_pay_target_replaced') };
  };

  it('bank journal reversed, plan now clearing: advisory names both targets and says the cash leg stays', async () => {
    given(bank(), clearing(), { state: 'out' });
    const { gate, note } = await advisory();
    expect(gate?.blocker).toBeNull();
    expect(gate?.replaces?.journalEntryId).toBe(JE);
    expect(note?.detail).toContain('1110 Bank - Primary');
    expect(note?.detail).toContain('2170 Net Salaries Payable');
    expect(note?.detail).toContain('JE-1');
    expect(note?.detail).toMatch(/cash leg of JE-1 stays where it was/);
  });

  it('clearing journal reversed, plan now the bank: advisory in the other direction', async () => {
    given(clearing(), bank(), { state: 'out' });
    const { gate, note } = await advisory();
    expect(gate?.blocker).toBeNull();
    expect(note?.detail).toContain('2170 Net Salaries Payable');
    expect(note?.detail).toContain('1110 Bank - Primary');
    expect(note?.detail).toMatch(/cash leg of JE-1 stays where it was/);
  });

  it('clearing A reversed, plan now clearing B, and a bank role that moved: advisories too', async () => {
    given(clearing(C2170), clearing(C2171), { state: 'out' });
    expect((await advisory()).note?.detail).toContain('2171 Net Salaries Payable 2');
    given(bank(BANK), bank(BANK_NEW), { state: 'out' });
    expect((await advisory()).note?.detail).toContain('1544331 New Bank');
  });

  it.each([
    ['bank to the same bank', bank(), bank()],
    ['clearing to the same clearing account', clearing(), clearing()],
  ])('no advisory when %s', async (_name, was, now) => {
    given(was, now, { state: 'out' });
    expect((await advisory()).note).toBeUndefined();
  });

  it('no advisory for a journal in force (that one is the refusal), and none when the old journal has no net-pay description', async () => {
    given(bank(), clearing());
    expect((await advisory()).note).toBeUndefined();
    given(bank(), clearing(), { state: 'out', netDescription: null });
    expect((await advisory()).note).toBeUndefined();
  });

  it('the advisory never blocks and is not part of the hash', async () => {
    given(bank(), clearing(), { state: 'out' });
    const withNote = await judgePayrollApproval(CO, RUN);
    given(bank(), clearing(), { state: 'out' });
    vi.mocked(buildPayrollJournalPlan).mockResolvedValue({ ...(await buildPayrollJournalPlan(CO, RUN)), advisories: [] } as never);
    expect(withNote?.planHash).toBe((await judgePayrollApproval(CO, RUN))?.planHash);
  });
});
