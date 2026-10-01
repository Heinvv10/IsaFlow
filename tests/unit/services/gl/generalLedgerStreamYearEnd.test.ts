import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import {
  incomeStatementBalanceNullFrom,
  runningBalanceIsDefined,
} from '@/modules/accounting/services/gl/generalLedgerStreamYearEnd';

describe('incomeStatementBalanceNullFrom', () => {
  it('is the next FY start when the range reaches it', () => {
    expect(incomeStatementBalanceNullFrom('2025-03-01', '2026-03-01')).toBe('2026-03-01');
    expect(incomeStatementBalanceNullFrom('2025-03-01', '2026-09-30')).toBe('2026-03-01');
  });

  it('is null when the range ends the day before it', () => {
    expect(incomeStatementBalanceNullFrom('2025-03-01', '2026-02-28')).toBeNull();
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
