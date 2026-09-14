/**
 * K-084 — a loan that skips every calendar month with EXTEND_TERM never repays.
 *
 * POST /api/accounting/loans hands req.body straight to createLoan, and
 * validateCreate never looked at recurringSkipMonths against skipMode. The
 * engine then extended the term once per skipped period and produced ~95,700
 * rows running to the year 10000. Reject the impossible loan at the boundary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { createLoan, updateLoan } from '@/modules/accounting/services/loans/loanService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';

const BASE = {
  principal: 100_000,
  startDate: '2026-01-31',
  termMonths: 12,
  rateMode: 'FIXED' as const,
  fixedRate: 12,
};

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([{
    id: 'loan-1', company_id: COMPANY, principal: '100000', start_date: '2026-01-31',
    term_months: 12, rate_mode: 'FIXED', margin: '0', fixed_rate: '12', residual: '0',
    day_count: 'ACTUAL_365', reprice_mode: 'RESOLVE_ON_RATE_CHANGE', skip_mode: 'EXTEND_TERM',
    lump_mode: 'REDUCE_INSTALLMENT', recurring_skip_months: [1, 2], currency: 'ZAR',
    origination_fee: '0', origination_fee_vat_type: 'standard', status: 'active',
    created_at: '2026-01-01', updated_at: '2026-01-01',
  }]);
});

describe('createLoan — recurringSkipMonths against skipMode', () => {
  it('refuses every month skipped with EXTEND_TERM, without touching the database', async () => {
    await expect(
      createLoan(COMPANY, { ...BASE, skipMode: 'EXTEND_TERM', recurringSkipMonths: ALL_MONTHS }),
    ).rejects.toThrow(/twelve months/i);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('refuses a duplicated, out-of-range list that still covers all twelve months', async () => {
    await expect(
      createLoan(COMPANY, {
        ...BASE,
        skipMode: 'EXTEND_TERM',
        recurringSkipMonths: [...ALL_MONTHS, ...ALL_MONTHS, 0, 13, 99],
      }),
    ).rejects.toThrow(/twelve months/i);
  });

  it('accepts every month skipped when the term is maintained', async () => {
    await expect(
      createLoan(COMPANY, { ...BASE, skipMode: 'MAINTAIN_TERM', recurringSkipMonths: ALL_MONTHS }),
    ).resolves.toBeDefined();
  });

  it('accepts a normal payment holiday with EXTEND_TERM', async () => {
    await expect(
      createLoan(COMPANY, { ...BASE, skipMode: 'EXTEND_TERM', recurringSkipMonths: [1, 2] }),
    ).resolves.toBeDefined();
  });
});

describe('updateLoan — switching an existing loan to EXTEND_TERM', () => {
  /** A loan already skipping all twelve months, stored with MAINTAIN_TERM. */
  function storedLoan(skipMode: string, months: number[]): Record<string, unknown> {
    return {
      id: 'loan-1', company_id: COMPANY, principal: '100000', start_date: '2026-01-31',
      term_months: 12, rate_mode: 'FIXED', margin: '0', fixed_rate: '12', residual: '0',
      day_count: 'ACTUAL_365', reprice_mode: 'RESOLVE_ON_RATE_CHANGE', skip_mode: skipMode,
      lump_mode: 'REDUCE_INSTALLMENT', recurring_skip_months: months, currency: 'ZAR',
      origination_fee: '0', origination_fee_vat_type: 'standard', status: 'active',
      created_at: '2026-01-01', updated_at: '2026-01-01',
    };
  }

  it('refuses the switch and writes nothing', async () => {
    sqlMock.mockResolvedValue([storedLoan('MAINTAIN_TERM', ALL_MONTHS)]);

    await expect(
      updateLoan(COMPANY, 'loan-1', { skipMode: 'EXTEND_TERM' }),
    ).rejects.toThrow(/twelve months/i);

    // Only the read of the existing loan ran; no UPDATE was issued.
    const statements = sqlMock.mock.calls.map((c) => (c[0] as string[]).join('?'));
    expect(statements.every((q) => !q.includes('UPDATE loans'))).toBe(true);
  });

  it('allows the switch when the loan keeps a repayable skip list', async () => {
    sqlMock.mockResolvedValue([storedLoan('MAINTAIN_TERM', [1, 2])]);

    await expect(
      updateLoan(COMPANY, 'loan-1', { skipMode: 'EXTEND_TERM' }, { force: true }),
    ).resolves.toBeDefined();
  });

  it('does not read the loan when skipMode is left alone', async () => {
    sqlMock.mockResolvedValue([storedLoan('EXTEND_TERM', ALL_MONTHS)]);

    await expect(updateLoan(COMPANY, 'loan-1', { reference: 'LN-9' })).resolves.toBeDefined();
    const statements = sqlMock.mock.calls.map((c) => (c[0] as string[]).join('?'));
    expect(statements.some((q) => q.includes('UPDATE loans'))).toBe(true);
  });
});
