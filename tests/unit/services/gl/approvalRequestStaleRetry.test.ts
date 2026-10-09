/**
 * R-035 N1 round 1 (blind LOW 3 / adversarial L1): a rule added or edited, or
 * the amount moved, between requestApproval's checkApproval and the definer
 * write is refused by approval_request_raise with RA010 and nothing written.
 * requestApproval re-reads once and raises again — binding the rule that
 * governs now — and a second race is ApprovalRequestStaleError (the route's
 * 409), never the 500 a bare RA010 would be. Mocked at the driver: the window
 * is between two statements of one request.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), { transaction: vi.fn(), unsafe: vi.fn((s: string) => s) });
  return { sql: sqlMock, withSavepoint: (_n: string, fn: () => Promise<unknown>) => fn(), withTransaction: vi.fn(),
    fmtDate: (d: unknown) => String(d) };
});
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: async () => undefined }));

import { sql } from '@/lib/neon';
import { requestApproval } from '@/modules/accounting/services/gl/approvalDocuments';
import { ApprovalRequestStaleError } from '@/modules/accounting/services/gl/approvalDocumentErrors';

const sqlMock = sql as unknown as MockedFunction<() => Promise<unknown[]>>;
const DOC = '22222222-2222-2222-2222-222222222222';
const rule = (id: string, role: string) => ({ id, name: role, document_type: 'supplier_invoice', condition_field: 'amount',
  condition_operator: 'any', condition_value: 0, approver_role: role, is_active: true, priority: 100, created_at: '2026-10-08' });
const stale = Object.assign(new Error('R035_APPROVAL_REQUEST_STALE'), { code: 'RA010' });
const inserted = { id: '55555555-5555-5555-5555-555555555555', rule_id: 'r-owner', document_type: 'supplier_invoice',
  document_id: DOC, status: 'pending', requested_by: 'u', requested_at: '2026-10-08', required_role: 'owner' };

const raise = () => requestApproval('c', { documentType: 'supplier_invoice', documentId: DOC, requestedBy: 'u' });

/** resolve, checkApproval (pending, rules), then the definer insert. */
const round = (rules: object[], insert: 'stale' | object) => {
  sqlMock.mockResolvedValueOnce([{ amount: '500000', reference: 'AP-1', digest: 'd' }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(rules);
  if (insert === 'stale') sqlMock.mockRejectedValueOnce(stale); else sqlMock.mockResolvedValueOnce([insert]);
};

describe('requestApproval — the rule set moved under the raise', () => {
  beforeEach(() => { sqlMock.mockReset(); });

  it('re-reads once and binds the rule that governs now', async () => {
    round([rule('r-manager', 'manager')], 'stale');
    round([rule('r-manager', 'manager'), rule('r-owner', 'owner')], inserted);
    const result = await raise();
    expect(result).toMatchObject({ id: inserted.id, requiredRole: 'owner' });
    expect(sqlMock).toHaveBeenCalledTimes(8);
  });

  it('a second race is ApprovalRequestStaleError (the 409), not a bare RA010', async () => {
    round([rule('r-manager', 'manager')], 'stale');
    round([rule('r-manager', 'manager')], 'stale');
    await expect(raise()).rejects.toBeInstanceOf(ApprovalRequestStaleError);
    expect(sqlMock).toHaveBeenCalledTimes(8);
  });
});
