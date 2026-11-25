/**
 * Wave 7 GC2: the creditor lines' judges with the database mocked, one answer per query in order. Real-PG behaviour
 * (byte fixture, journal, refusals that change no row) is tests/integration/w7-gc2-creditor-lines.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const answers = vi.hoisted(() => [] as unknown[][]);
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => answers.shift() ?? []) }));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({ createJournalEntry: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({ postJournalEntry: vi.fn() }));

import { judgeCreditorConfirm } from '@/modules/accounting/services/payroll/payrollBankFileCreditorJournal';
import { readCreditorPayments } from '@/modules/accounting/services/payroll/payrollBankFileCreditors';
import { PayrollBankFileRefusal } from '@/modules/accounting/services/payroll/payrollBankFileStatus';

const RUN = { period_year: 2026, period_month: 11, pay_frequency: 'monthly', run_kind: 'regular', off_cycle_reason: null, run_date: null, period_end: '2026-11-30' };
const item = (o: Partial<Record<string, unknown>> = {}) => ({
  cents: '1000000', creditor_name: 'Acme Credit', employee_number: 'E1', payable: 'pay-1', changed: false, payable_active: true,
  action_date: '2026-11-25', ...o,
});
const judge = () => judgeCreditorConfirm({ companyId: 'co', runId: 'run', fileId: 'file', paidAsGenerated: false });
const refusal = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(PayrollBankFileRefusal);
  return err as PayrollBankFileRefusal;
};

beforeEach(() => { answers.length = 0; });

describe('judgeCreditorConfirm', () => {
  it('two orders crediting ONE payable account are one debit line (grouped), balanced by one credit to the net-pay account', async () => {
    answers.push([item(), item({ creditor_name: 'Beta Loans', cents: '250050' }), item({ payable: 'pay-2', cents: '100' })],
      [], [RUN], [{ id: 'bank-1', is_active: true }]);
    const p = await judge();
    expect(p!.lines).toEqual([
      { glAccountId: 'pay-1', debit: 12500.5, credit: 0, description: 'Garnishee creditors paid by salary bank file' },
      { glAccountId: 'pay-2', debit: 1, credit: 0, description: 'Garnishee creditors paid by salary bank file' },
      { glAccountId: 'bank-1', debit: 0, credit: 12501.5, description: 'Garnishee creditors paid by salary bank file' },
    ]);
    expect(p!.totalCents).toBe(1250150);
    expect(p!.lines.reduce((s, l) => s + l.debit - l.credit, 0)).toBeCloseTo(0, 6);
    expect(p!.entryDate).toBe('2026-11-25');
  });

  it('JOURNAL_NOT_POSTED when the run has no posted journal of its own in force crediting net pay', async () => {
    answers.push([item()], [], [RUN], []);
    expect((await refusal(judge())).reason).toBe('JOURNAL_NOT_POSTED');
  });

  it('CREDITORS_NOT_PAYABLE when the garnishee payable, or the net-pay account, is deactivated', async () => {
    answers.push([item({ payable_active: false })], [], [RUN], [{ id: 'bank-1', is_active: true }]);
    expect((await refusal(judge())).reason).toBe('CREDITORS_NOT_PAYABLE');
    answers.push([item()], [], [RUN], [{ id: 'bank-1', is_active: false }]);
    expect((await refusal(judge())).reason).toBe('CREDITORS_NOT_PAYABLE');
  });

  it('PERIOD_CLOSED names the period; CREDITOR_DETAILS_CHANGED names the order unless attested', async () => {
    answers.push([item()], [{ name: 'Nov 2026' }]);
    const closed = await refusal(judge());
    expect([closed.reason, closed.message.includes('Nov 2026')]).toEqual(['PERIOD_CLOSED', true]);
    answers.push([item({ changed: true })]);
    const changed = await refusal(judge());
    expect([changed.reason, changed.problems]).toEqual(['CREDITOR_DETAILS_CHANGED', ['Acme Credit (employee E1)']]);
    answers.push([item({ changed: true })], [], [RUN], [{ id: 'bank-1', is_active: true }]);
    const attested = await judgeCreditorConfirm({ companyId: 'co', runId: 'run', fileId: 'file', paidAsGenerated: true });
    expect(attested!.attestedChanged).toEqual(['Acme Credit (employee E1)']);
  });

  it('nothing to post for a file without creditor lines', async () => {
    answers.push([]);
    expect(await judge()).toBeNull();
  });
});

describe('readCreditorPayments', () => {
  const row = (o: Partial<Record<string, unknown>> = {}) => ({
    order_id: 'o1', employee_id: 'e1', cents: '1000000', balance_applied: true, employee_number: 'E1', reference: 'EAO 1/2027',
    creditor_name: 'Acme Credit', creditor_account_holder: null, creditor_bank_name: 'FNB', creditor_branch_code: '250655',
    creditor_account_number: '62001234567', creditor_account_type: 'cheque', set_at: '2026-11-25 10:00:00.123456+00',
    creditor_bank_set_by: 'u1', setter_role: 'owner', ...o,
  });

  it('refuses by name an account over 11 digits (the ACB layout\'s limit), no details, an unapplied deduction', async () => {
    answers.push([row({ creditor_account_number: '123456789012' }), row({ creditor_name: 'B', creditor_account_number: null }),
      row({ creditor_name: 'C', balance_applied: false })]);
    const err = await refusal(readCreditorPayments('co', 'run'));
    expect([err.reason, err.problems]).toEqual(['CREDITORS_NOT_PAYABLE', [
      'Acme Credit (employee E1): the creditor account number has more than 11 digits, which a bank file cannot carry',
      'B (employee E1): the garnishee order has no creditor bank details',
      'C (employee E1): the run\'s approval has not applied this deduction',
    ]]);
  });

  it('keeps the version token as text (microseconds) and names a non-admin entry in the warnings', async () => {
    answers.push([row({ setter_role: 'manager' })]);
    const out = await readCreditorPayments('co', 'run');
    expect(out.lines[0]!.snapshot.setAt).toBe('2026-11-25 10:00:00.123456+00');
    expect(out.lines[0]!.payment).toMatchObject({ amountCents: 1000000, reference: 'EAO 1/2027', accountName: 'Acme Credit' });
    expect(out.warnings).toEqual([expect.stringContaining('were entered by a manager, not an owner or admin')]);
  });
});
