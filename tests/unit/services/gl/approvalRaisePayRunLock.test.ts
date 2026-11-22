/**
 * #1670 breaker L5: raising (or re-requesting) a pay_run approval takes the company's pay-run approver lock
 * (payRunApproverGuard.lockPayRunApprovers, the key a member write judging pending requests takes) before the raise reads
 * anything, so a withhold / demotion and a raise serialise. Other document types take no such lock. The real lock is
 * exercised on Postgres in tests/integration/payroll-sole-approver.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => { throw new Error('stop after the first read'); }), withSavepoint: (_n: string, fn: () => unknown) => fn(),
  withTransaction: vi.fn(), fmtDate: (d: unknown) => String(d),
}));
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: async () => undefined }));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceLock', () => ({ withSupplierInvoiceLock: async () => undefined }));
vi.mock('@/modules/accounting/services/core/payRunApproverGuard', () => ({ lockPayRunApprovers: vi.fn(async () => undefined) }));

import { sql } from '@/lib/neon';
import { lockPayRunApprovers } from '@/modules/accounting/services/core/payRunApproverGuard';
import { requestApproval } from '@/modules/accounting/services/gl/approvalDocuments';

const C = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';

beforeEach(() => { vi.mocked(sql).mockClear(); vi.mocked(lockPayRunApprovers).mockClear(); });

describe('requestApproval — the pay-run approver lock', () => {
  it('a pay_run raise takes the approver lock of its company before its first read', async () => {
    await expect(requestApproval(C, { documentType: 'pay_run', documentId: DOC, requestedBy: 'u' })).rejects.toThrow('stop');
    expect(lockPayRunApprovers).toHaveBeenCalledWith(C);
    expect(vi.mocked(lockPayRunApprovers).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(sql).mock.invocationCallOrder[0]!);
  });

  it('another document type takes no approver lock', async () => {
    await expect(requestApproval(C, { documentType: 'manual_journal', documentId: DOC, requestedBy: 'u' })).rejects.toThrow('stop');
    expect(lockPayRunApprovers).not.toHaveBeenCalled();
  });
});
