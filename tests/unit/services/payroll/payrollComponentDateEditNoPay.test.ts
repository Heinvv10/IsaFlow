/**
 * Edit dates, End and cancel (changeAssignmentDates) never put the employee's pay in the logs, the audit row or a
 * refusal message: only ids and the window (from, to, recurring). The row's amount is read (siblings) but must not
 * travel (security review, 2026-11-02).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const AMOUNT = 31_234.56;
const SIBLING_AMOUNT = 4_321.09;
const bound: unknown[][] = [];
let selfRow: Record<string, unknown> = {};
let siblingRow: Record<string, unknown> | null = null;
let paidMonths: Array<Record<string, unknown>> = [];

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => {
  const tx = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    bound.push(values);
    if (text.includes('JOIN payroll_employees e')) {
      return [{ id: selfRow.id, employee_id: 'e-1', component_id: 'c-1', component_type: selfRow.component_type ?? 'earning' }];
    }
    if (text.includes('AS employee_end')) return [selfRow, ...(siblingRow ? [siblingRow] : [])];
    if (text.includes('FROM payroll_run_headers h')) return paidMonths;
    return [];
  };
  return { sql: tx, withTransaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
});

import { log } from '@/lib/logger';
import { changeAssignmentDates } from '@/modules/accounting/services/payroll/payrollComponentDateEdit';

const ID = '11111111-1111-4111-8111-111111111111';
const actor = { userId: 'u-1', channel: 'rest' as const };

function payTravelled(): string[] {
  const out: string[] = [];
  const logged = [...vi.mocked(log.info).mock.calls, ...vi.mocked(log.warn).mock.calls];
  for (const call of logged) {
    const text = JSON.stringify(call);
    if (text.includes('"amount"')) out.push(`log has an amount key: ${text}`);
    if (text.includes(String(AMOUNT)) || text.includes(String(SIBLING_AMOUNT))) out.push(`log has the pay: ${text}`);
  }
  for (const values of bound) {
    const text = JSON.stringify(values);
    if (text.includes(String(AMOUNT)) || text.includes('"amount"')) out.push(`a write bound the pay: ${text}`);
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  bound.length = 0;
  siblingRow = null;
  paidMonths = [];
});

describe('no pay in logs, audit rows or refusals', () => {
  it('Edit dates on a recurring row', async () => {
    selfRow = { id: ID, amount: AMOUNT, effective_from: '2026-03-30', effective_to: null, is_recurring: true };
    expect(await changeAssignmentDates('co-1', ID, { kind: 'edit', from: '2026-04-01', to: null }, actor)).toBe(true);
    expect(vi.mocked(log.info)).toHaveBeenCalled();
    expect(payTravelled()).toEqual([]);
  });

  it('End on a recurring row', async () => {
    selfRow = { id: ID, amount: AMOUNT, effective_from: '2026-01-01', effective_to: null, is_recurring: true };
    expect(await changeAssignmentDates('co-1', ID, { kind: 'end', to: '2026-03-31' }, actor)).toBe(true);
    expect(payTravelled()).toEqual([]);
  });

  it('cancel (End on an unpaid once-off)', async () => {
    selfRow = { id: ID, amount: AMOUNT, effective_from: '2026-03-10', effective_to: '2026-03-31', is_recurring: false };
    expect(await changeAssignmentDates('co-1', ID, { kind: 'end', to: '2026-03-20' }, actor)).toBe(true);
    expect(payTravelled()).toEqual([]);
  });

  it('a refusal for a paid month names the month, not the pay', async () => {
    selfRow = { id: ID, amount: AMOUNT, effective_from: '2026-01-01', effective_to: null, is_recurring: true, superseded_at: null };
    paidMonths = [{ period_year: 2026, period_month: 3, status: 'approved', journal_entry_id: null }];
    const refused = await changeAssignmentDates('co-1', ID, { kind: 'end', to: '2026-03-15' }, actor).catch((e: Error) => e.message);
    expect(refused).toMatch(/2026-03 .*already paid/);
    expect(String(refused)).not.toContain(String(AMOUNT));
    expect(payTravelled()).toEqual([]);
  });

  it('refuses removing a pre-27th leaver salary from a paid termination base', async () => {
    selfRow = {
      id: ID, amount: AMOUNT, effective_from: '2026-01-01', effective_to: '2026-03-15',
      is_recurring: true, employee_end: '2026-03-15', superseded_at: null,
    };
    paidMonths = [{
      period_year: 2026, period_month: 3, status: 'approved', journal_entry_id: null,
      calculated_at: '2026-03-31T12:00:00.000Z',
    }];

    const refused = await changeAssignmentDates(
      'co-1', ID, { kind: 'edit', from: '2026-01-01', to: '2026-03-14' }, actor,
    ).catch((e: Error) => e.message);

    expect(refused).toMatch(/2026-03 .*already paid/);
    expect(payTravelled()).toEqual([]);
  });
});
