/**
 * R-035 PR2 review LOW-4: the import exemption is a transaction-local GUC. With
 * no request transaction (no ALS-bound client) set_config(..., true) lasts one
 * autocommit statement, so the write after it ran UNexempt — silently, until
 * the backstop refused it. The wrapper now refuses to run outside a transaction.
 */
import { describe, expect, it, vi } from 'vitest';

const neon = vi.hoisted(() => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/neon', () => ({
  sql: neon.sql,
  // Outside a request transaction the real withSavepoint just runs the callback.
  withSavepoint: (_name: string, fn: () => Promise<unknown>) => fn(),
}));

import { als } from '@/lib/als';
import { withApprovalGateExempt } from '@/modules/accounting/services/gl/approvalGateExempt';

describe('withApprovalGateExempt outside a request transaction', () => {
  it('throws a clear error and never runs the write', async () => {
    expect(als.getStore()).toBeUndefined();
    const write = vi.fn(async () => 'written');
    await expect(withApprovalGateExempt({ companyId: 'c', userId: 'u', open: false }, write))
      .rejects.toThrow(/request transaction/);
    expect(write).not.toHaveBeenCalled();
    expect(neon.sql).not.toHaveBeenCalled();
  });
});
