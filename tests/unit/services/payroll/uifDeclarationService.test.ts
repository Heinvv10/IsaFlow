// RED phase — written before implementation
/**
 * UIF (UI-19) declarable-status guard.
 *
 * `payrollApprovalService` posts the payroll GL journal at the APPROVE
 * transition, and that journal is the only thing that credits 2150 UIF Payable
 * (payrollJournalPostingService: `CR 2150 = total_uif`). A run sitting in
 * 'calculated' therefore has NO UIF liability in the ledger at all.
 *
 * Including such a run in the UI-19 declares UIF to the UIF fund that the
 * ledger does not carry, and `markUifDeclarationPaid` then DEBITS 2150 for the
 * declared total — driving the control account negative by exactly the
 * unposted amount. Same argument as EMP201, so UIF reuses the same declarable
 * set (UI19_DECLARABLE_STATUSES === EMP201_DECLARABLE_STATUSES).
 *
 * Assertions are on the BOUND PARAMETERS, not the SQL text, so an explanatory
 * SQL comment mentioning 'calculated' cannot make these pass falsely.
 *
 * Mutation check (apply each alone, expect red):
 *  1. In generateUifDeclaration, swap the bound array back to
 *     `['calculated', 'approved', 'paid']` → "aggregates only GL-posted runs" fails.
 *  2. Same swap in getUifDeclaration's line query → "lists only GL-posted runs" fails.
 *  3. Change UI19_DECLARABLE_STATUSES to include 'calculated'
 *     → both tests plus the constant test fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock, withTransaction: vi.fn() };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/uifEngine', () => ({
  calculateUIF: () => ({ employeeContribution: 177.12, employerContribution: 177.12, isCapped: false }),
}));
vi.mock('@/modules/accounting/services/payroll/taxTables', () => ({ getTaxYear: () => 2027 }));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({ getAccountByCode: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({ createJournalEntry: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({ postJournalEntry: vi.fn() }));

import { sql } from '@/lib/neon';
import {
  generateUifDeclaration,
  getUifDeclaration,
} from '@/modules/accounting/services/payroll/uifDeclarationService';
import {
  UI19_DECLARABLE_STATUSES,
  EMP201_DECLARABLE_STATUSES,
} from '@/lib/constants/payrollRunStatuses';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const DECL_ID = 'dddddddd-0000-0000-0000-000000000002';
const USER_ID = 'cccccccc-0000-0000-0000-000000000003';

/** Flattens every value bound into any sql`` call made during the test. */
function allBoundValues(): unknown[] {
  return vi.mocked(sql).mock.calls.flatMap((call) => Array.from(call).slice(1));
}

/** True if any bound value is (or contains) `status`. */
function bindsStatus(status: string): boolean {
  return allBoundValues().some(
    (v) => v === status || (Array.isArray(v) && v.includes(status)),
  );
}

const declarationRow = {
  id: DECL_ID,
  company_id: COMPANY_ID,
  period_year: 2026,
  period_month: 3,
  uif_reference: null,
  total_employees: 10,
  total_leviable_salary: 162_484,
  total_employee_contribution: 1624.84,
  total_employer_contribution: 1624.84,
  status: 'draft',
  submitted_at: null,
  submitted_by: null,
  notes: null,
  journal_entry_id: null,
  payment_date: null,
  created_at: new Date('2026-03-31T00:00:00Z'),
  updated_at: new Date('2026-03-31T00:00:00Z'),
};

describe('UI19_DECLARABLE_STATUSES', () => {
  it('excludes statuses with no GL journal and matches the EMP201 set', () => {
    expect([...UI19_DECLARABLE_STATUSES]).toEqual(['approved', 'paid']);
    expect([...UI19_DECLARABLE_STATUSES]).toEqual([...EMP201_DECLARABLE_STATUSES]);
    expect([...UI19_DECLARABLE_STATUSES]).not.toContain('calculated');
    expect([...UI19_DECLARABLE_STATUSES]).not.toContain('draft');
    expect([...UI19_DECLARABLE_STATUSES]).not.toContain('cancelled');
  });
});

describe('generateUifDeclaration', () => {
  beforeEach(() => vi.mocked(sql).mockReset());

  it('aggregates only GL-posted runs — never a "calculated" run', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([
        { employee_count: 10, total_uif_employee: 1624.84, total_uif_employer: 1624.84 },
      ] as never)
      .mockResolvedValueOnce([declarationRow] as never);

    await generateUifDeclaration(COMPANY_ID, 2026, 3, USER_ID);

    expect(bindsStatus('approved')).toBe(true);
    expect(bindsStatus('paid')).toBe(true);
    expect(bindsStatus('calculated')).toBe(false);
    expect(bindsStatus('draft')).toBe(false);
    expect(bindsStatus('cancelled')).toBe(false);
  });
});

describe('getUifDeclaration', () => {
  beforeEach(() => vi.mocked(sql).mockReset());

  it('lists only GL-posted runs — never a "calculated" run', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([declarationRow] as never)
      .mockResolvedValueOnce([] as never);

    const detail = await getUifDeclaration(COMPANY_ID, DECL_ID);

    expect(detail).not.toBeNull();
    expect(bindsStatus('approved')).toBe(true);
    expect(bindsStatus('paid')).toBe(true);
    expect(bindsStatus('calculated')).toBe(false);
  });
});
