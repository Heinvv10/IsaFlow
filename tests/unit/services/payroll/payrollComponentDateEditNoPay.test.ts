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

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => {
  const tx = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    bound.push(values);
    if (text.includes('JOIN payroll_employees e')) return [{ id: selfRow.id, employee_id: 'e-1', component_id: 'c-1' }];
    if (text.includes('effective_from, effective_to, is_recurring FROM payroll_employee_components')) return [selfRow, ...(siblingRow ? [siblingRow] : [])];
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

  it('a refusal naming a replaced once-off says its dates, not its pay', async () => {
    selfRow = { id: ID, amount: AMOUNT, effective_from: '2026-07-15', effective_to: '2026-07-31', is_recurring: false };
    siblingRow = { id: '22222222-2222-4222-8222-222222222222', amount: SIBLING_AMOUNT, effective_from: '2026-07-01', effective_to: '2026-07-14', is_recurring: false };
    const refused = await changeAssignmentDates('co-1', ID, { kind: 'end', to: '2026-07-20' }, actor).catch((e: Error) => e.message);
    expect(refused).toMatch(/2026-07-01 to 2026-07-14.*paid again/);
    expect(String(refused)).not.toContain(String(SIBLING_AMOUNT));
    expect(payTravelled()).toEqual([]);
  });
});
