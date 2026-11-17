/** PE review #1542 E-A2: a deadlock in the payslip email's lock step is the retryable lock refusal, not a 500. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { retryableLockFailure } from '@/modules/accounting/services/payroll/payslipDeliveryService';
import { PayrollLoanLockTimeoutError } from '@/modules/accounting/services/payroll/payrollLoanLock';
import { isLockTimeoutError } from '@/lib/lockTimeout';

describe('retryableLockFailure', () => {
  it('maps 40P01 to the retryable lock refusal the route answers as such; anything else passes through', () => {
    const mapped = retryableLockFailure(Object.assign(new Error('deadlock detected'), { code: '40P01' }), 'run-1');
    expect(mapped).toBeInstanceOf(PayrollLoanLockTimeoutError);
    expect(isLockTimeoutError(mapped)).toBe(true);
    const other = Object.assign(new Error('boom'), { code: '23505' });
    expect(retryableLockFailure(other, 'run-1')).toBe(other);
  });
});
