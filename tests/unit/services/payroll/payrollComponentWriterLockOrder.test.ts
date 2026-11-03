/**
 * The writers of payroll_employee_components beside the pay-run grid take the company
 * payroll lock before their first write: a row landing between a cell's read and its
 * write pays twice. Every statement, the lock's own included, goes in one log, so order
 * is what is judged. The lock is the company's payroll-approval advisory lock, taken in the
 * writer's transaction (payrollCompanyLock, master #1117): the same key the grid and
 * approval take. The wait itself is in tests/integration/payrun-period-inputs-loans.int.test.ts
 * and payroll-breaker-final-writers.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const trail = vi.hoisted(() => ({ log: [] as string[], rows: (_q: string): unknown[] => [] }));

vi.mock('@/lib/neon', () => {
  const run = async (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    trail.log.push(q);
    return trail.rows(q);
  };
  return { sql: run, withTransaction: async (fn: (tx: typeof run) => Promise<unknown>) => fn(run) };
});
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: async () => undefined }));
// The audit row each writer leaves goes through the audit service, not this trail.
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn(async () => undefined) }));

import { postBatch } from '@/modules/accounting/services/payroll/payrollBatchService';
import { applyPackageToEmployee } from '@/modules/accounting/services/payroll/payPackageService';

const [COMPANY, ITEM, EMPLOYEE, USER] = ['c0', 'i0', 'e0', 'u0'];
const COMPONENT = '11111111-1111-4111-8111-111111111111';
const WRITE = /^\s*(INSERT|UPDATE|DELETE)\b/;
const firstWrite = () => trail.log.findIndex((q) => WRITE.test(q));
/** The company payroll-approval lock: pg_advisory_xact_lock on the key payroll_approval:<company>, a bound value. */
const lockAt = () => trail.log.findIndex((q) => q.includes('pg_advisory_xact_lock(hashtextextended('));

beforeEach(() => {
  trail.log.length = 0;
});

describe('the company payroll lock comes before the first write', () => {
  it('postBatch', async () => {
    trail.rows = (q) => {
      if (q.includes('FROM payroll_batches')) {
        return [{ id: ITEM, company_id: COMPANY, batch_type: 'component_values', component_id: COMPONENT, status: 'validated', period_year: 2026, period_month: 11, is_recurring: false }];
      }
      if (q.includes('FROM payroll_components')) return [{ id: COMPONENT }];
      if (q.includes('FROM payroll_batch_lines')) return [{ id: 'l1', employee_id: EMPLOYEE, value: '700', effective_from: new Date('2026-11-01'), effective_to: null }];
      if (q.includes('INSERT INTO payroll_employee_components')) return [{ id: 'a1' }];
      return [];
    };
    expect((await postBatch(COMPANY, ITEM, USER)).inserted).toBe(1);
    expect(firstWrite()).toBeGreaterThan(-1);
    expect(lockAt()).toBeGreaterThan(-1);
    expect(lockAt()).toBeLessThan(firstWrite());
  });

  it('applyPackageToEmployee', async () => {
    trail.rows = (q) => {
      if (q.includes('FROM payroll_employees')) return [{ id: EMPLOYEE }];
      if (q.includes('FROM pay_packages')) return [{ id: ITEM }];
      if (q.includes('FROM pay_package_components')) return [{ component_id: 'c1', amount: '700', is_recurring: true }];
      if (q.includes('INSERT INTO payroll_employee_components')) return [{ id: 'a1' }];
      return [];
    };
    expect((await applyPackageToEmployee(COMPANY, ITEM, EMPLOYEE, '2026-11-01', USER)).inserted).toBe(1);
    expect(firstWrite()).toBeGreaterThan(-1);
    expect(lockAt()).toBeGreaterThan(-1);
    expect(lockAt()).toBeLessThan(firstWrite());
  });
});
