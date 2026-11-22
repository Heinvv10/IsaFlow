/**
 * #1656 round 7 (breaker M1): the journal a stand-alone SARS directive payment posts carried the employee's NAME in its description
 * and every line narrative. Journals are read by anyone with Accounting, who may not hold Payroll, and the amounts on the lines are one
 * person's severance and PAYE. The narrative now names the directive (its number, else its id's first 8) and nothing personal.
 * Journals already posted keep what they carry: no data migration.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const created: Array<{ description: string; lines: Array<{ description?: string }> }> = [];
const dir = { id: 'd1', employee_id: 'e1', employee_name: 'Thandi Nkosi', directive_number: 'IRP3-778899', directive_type: 'severance', status: 'approved', amount: '100000', tax_rate: 0.2, tax_amount: null };
const split = { advisories: [], lines: [] };

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (q.includes('FROM tax_directives')) return [dir];
    if (q.includes('FROM payroll_employees')) return [{ '?column?': 1 }];
    if (q.includes('FROM gl_accounts')) return [{ id: 'acct' }];
    if (q.includes('INSERT INTO tax_directive_payments')) return [{ id: 'pay1' }];
    return [];
  }),
}));
vi.mock('@/modules/accounting/services/core/documentClaimLock', () => ({ claimUnderLockTimeout: async (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  createJournalEntry: vi.fn(async (_c: string, input: (typeof created)[number]) => { created.push(input); return { id: 'je1' }; }),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({ postJournalEntry: vi.fn(async () => undefined), InactiveAccountError: class extends Error {} }));
vi.mock('@/modules/accounting/services/gl/paymentBankAccount', () => ({ resolvePaymentBankAccount: vi.fn(async () => 'bank1') }));
vi.mock('@/modules/accounting/services/payroll/taxDirectiveLabour', () => ({
  lockDirectiveLabour: vi.fn(async () => split),
  refreshDirectiveLabour: vi.fn(async () => split),
  postOrRetry: vi.fn(async (_c: string, _d: string, _l: unknown, _a: string, run: () => unknown) => run()),
}));
vi.mock('@/modules/accounting/services/payroll/taxDirectivePaidGuard', () => ({
  reversedStandalonePayments: vi.fn(async () => []), releaseReversedStandalonePayment: vi.fn(async () => undefined),
}));
vi.mock('@/modules/accounting/services/payroll/payrollCostCentreTags', () => ({
  employeeLabourLines: vi.fn((_s: unknown, amount: number, acct: string, description: string) => [{ glAccountId: acct, debit: amount, credit: 0, description }]),
}));

import { applyTaxDirective } from '@/modules/accounting/services/payroll/taxDirectivePaymentService';

beforeEach(() => { created.length = 0; });

describe('applyTaxDirective journal narrative', () => {
  it('names the directive number and never the employee, on the journal and on every line', async () => {
    await applyTaxDirective('c1', 'd1', { paymentDate: '2026-05-20' }, 'u1');
    const j = created[0]!;
    expect(j.description).toBe('SARS directive IRP3-778899');
    expect(j.lines).toHaveLength(3);
    for (const l of j.lines) expect(l.description).toMatch(/^SARS directive IRP3-778899 — /);
    expect(JSON.stringify(j)).not.toMatch(/Thandi|Nkosi/);
  });

  it('a directive without a number is named by the first 8 of its id', async () => {
    const saved = dir.directive_number;
    (dir as { directive_number: string | null }).directive_number = null;
    try {
      await applyTaxDirective('c1', 'd1', { paymentDate: '2026-05-20' }, 'u1');
    } finally {
      (dir as { directive_number: string | null }).directive_number = saved;
    }
    expect(created[0]!.description).toBe('SARS directive d1');
  });
});
