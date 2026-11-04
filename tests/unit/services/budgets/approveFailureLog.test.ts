/**
 * Budgets P5-2 (security review S3): approve's catch logs a budget refusal as an answer (info, its code
 * only: the refusal's lines carry the company's budget figures) and every other failure as an error,
 * with the error. The catch always re-throws (supplierInvoiceWorkflowService.approveInner).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { log } from '@/lib/logger';
import { logApproveFailure } from '@/modules/accounting/services/ap/supplierInvoiceBudgetCheck';
import { BudgetCheckLockTimeoutError, BudgetExceededError, BudgetReasonRequiredError } from '@/modules/accounting/services/budgets/budgetCheckTypes';

const event = {
  companyId: 'c', documentType: 'supplier_invoice' as const, documentId: 'd', documentRef: 'INV-1', policy: 'block' as const,
  lines: [], reason: null, channel: 'ui' as const, actorId: 'u',
};

describe('logApproveFailure', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a budget refusal: info, the code only, no figures', () => {
    for (const err of [new BudgetExceededError('Over budget — remaining R 1.00', event), new BudgetReasonRequiredError('Give a reason', []),
      new BudgetCheckLockTimeoutError()]) {
      logApproveFailure('inv-1', err);
    }
    expect(log.error).not.toHaveBeenCalled();
    expect(vi.mocked(log.info).mock.calls.map((c) => c[1])).toEqual([
      { id: 'inv-1', code: 'BUDGET_EXCEEDED' }, { id: 'inv-1', code: 'BUDGET_REASON_REQUIRED' }, { id: 'inv-1', code: 'BUDGET_CHECK_LOCK_TIMEOUT' },
    ]);
    expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain('R 1.00');
  });

  it('anything else: an error, with the error', () => {
    const err = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    logApproveFailure('inv-2', err);
    expect(log.error).toHaveBeenCalledWith('Failed to approve supplier invoice', { id: 'inv-2', error: err }, 'accounting');
    expect(log.info).not.toHaveBeenCalled();
  });
});
