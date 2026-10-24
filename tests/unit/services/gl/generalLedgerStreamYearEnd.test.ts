import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry',
  async () => (await import('../../../helpers/fiscalYearSqlFake')).registryMock());
vi.mock('@/modules/accounting/services/gl/trialBalanceBasis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/gl/trialBalanceBasis')>()),
  getRetainedEarningsBroughtForward: vi.fn(async () => 123.45),
}));

import {
  incomeStatementBalanceNullFrom,
  runningBalanceIsDefined,
  streamFiscalBasis,
} from '@/modules/accounting/services/gl/generalLedgerStreamYearEnd';
import { fakeRegistry, resetFakeRegistry, TRANSITION_YEARS } from '../../../helpers/fiscalYearSqlFake';

describe('streamFiscalBasis', () => {
  beforeEach(() => resetFakeRegistry());

  it('takes the floor and the next start from the registry year holding periodStart', async () => {
    const basis = await streamFiscalBasis('c1', '2025-09-01', true, '2025-09-30');
    expect(basis).toEqual({ fyStart: '2025-03-01', nextFyStart: '2026-03-01', retainedBf: 123.45 });
  });

  it('uses a 14-month transition year at its own length: it ends 14 months after it starts', async () => {
    fakeRegistry.years = TRANSITION_YEARS;
    const basis = await streamFiscalBasis('c1', '2026-06-01', false, '2026-06-30');
    // FY2027 is 2026-01-01 to 2027-02-28, so the next year starts 2027-03-01, not 2027-01-01.
    expect(basis).toEqual({ fyStart: '2026-01-01', nextFyStart: '2027-03-01', retainedBf: null });
  });

  it('refuses a malformed date before asking the registry', async () => {
    await expect(streamFiscalBasis('c1', 'garbage', true, '2025-09-30')).rejects.toThrow();
  });
});

describe('incomeStatementBalanceNullFrom', () => {
  it('is the next FY start when the range reaches it', () => {
    expect(incomeStatementBalanceNullFrom('2026-03-01', '2026-03-01')).toBe('2026-03-01');
    expect(incomeStatementBalanceNullFrom('2026-03-01', '2026-09-30')).toBe('2026-03-01');
  });

  it('is null when the range ends the day before it', () => {
    expect(incomeStatementBalanceNullFrom('2026-03-01', '2026-02-28')).toBeNull();
  });
});

describe('runningBalanceIsDefined', () => {
  const from = '2026-03-01';
  it('keeps a P&L balance before the boundary and drops it on or after', () => {
    expect(runningBalanceIsDefined('expense', '2026-02-28', from)).toBe(true);
    expect(runningBalanceIsDefined('expense', '2026-03-01', from)).toBe(false);
    expect(runningBalanceIsDefined('revenue', '2027-01-01', from)).toBe(false);
  });

  it('never drops a balance-sheet account, nor any when there is no boundary', () => {
    expect(runningBalanceIsDefined('asset', '2027-01-01', from)).toBe(true);
    expect(runningBalanceIsDefined('equity', '2027-01-01', from)).toBe(true);
    expect(runningBalanceIsDefined('expense', '2027-01-01', null)).toBe(true);
  });
});
