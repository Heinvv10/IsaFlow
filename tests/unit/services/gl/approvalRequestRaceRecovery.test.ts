/**
 * K-043 round-6 LOW-1: the 23505 recovery arm of `requestApproval` was never
 * executed by any test.
 *
 * The concurrent-POST integration case cannot reach it — the handlers serialise
 * in-process, so the second call sees the pending row in `checkApproval` and
 * returns through `rebindPendingRequest` without ever issuing the INSERT. What
 * the arm has to do when it DOES fire (a racer committed between this request's
 * read and its insert) is: roll the savepoint back rather than poison the
 * transaction, re-read, and return the racer's row re-bound under the ratchet.
 *
 * Mocked at the driver, because the thing under test is the response to a
 * Postgres error code, and producing that error for real means a second process
 * winning a race at a precise instant.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

const savepoint = vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn());

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(), unsafe: vi.fn((s: string) => s),
  });
  return {
    sql: sqlMock,
    withSavepoint: (name: string, fn: () => Promise<unknown>) => savepoint(name, fn),
    withTransaction: vi.fn(),
    fmtDate: (d: unknown) => String(d),
  };
});

import { sql } from '@/lib/neon';
import { requestApproval } from '@/modules/accounting/services/gl/approvalDocuments';

const sqlMock = sql as unknown as MockedFunction<() => Promise<unknown[]>>;

const COMPANY = '11111111-1111-1111-1111-111111111111';
const DOCUMENT = '22222222-2222-2222-2222-222222222222';
const REQUESTER = '33333333-3333-3333-3333-333333333333';
const RULE = '44444444-4444-4444-4444-444444444444';

const ruleRow = (role: string) => ({
  id: RULE, name: 'r6 rule', document_type: 'supplier_invoice', condition_field: 'amount',
  condition_operator: 'any', condition_value: 0, approver_role: role, is_active: true,
  priority: 100, created_at: '2026-09-10T00:00:00.000Z',
});

const racedRow = (role: string) => ({
  id: '55555555-5555-5555-5555-555555555555', rule_id: RULE, document_type: 'supplier_invoice',
  document_id: DOCUMENT, document_reference: 'AP-1', amount: '500000', status: 'pending',
  requested_by: 'someone-else', requested_at: '2026-09-10T00:00:00.000Z',
  decided_by: null, decided_at: null, decision_notes: null,
  effective_required_role: role, required_role: role,
});

const conflict = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

const raise = () => requestApproval(COMPANY, {
  documentType: 'supplier_invoice', documentId: DOCUMENT, requestedBy: REQUESTER,
});

/**
 * The statement order requestApproval issues: resolve the document, then
 * checkApproval's (existing, rules) pair, then the INSERT.
 */
function driver(options: { racerRole: string; ruleRole: string }) {
  sqlMock.mockReset();
  sqlMock
    .mockResolvedValueOnce([{ amount: '500000', reference: 'AP-1' }])   // findDocument
    .mockResolvedValueOnce([])                                          // checkApproval: no pending row
    .mockResolvedValueOnce([ruleRow(options.ruleRole)])                 // checkApproval: rules
    .mockRejectedValueOnce(conflict)                                    // INSERT loses the race
    .mockResolvedValueOnce([racedRow(options.racerRole)])               // re-read: the racer's row
    .mockResolvedValueOnce([ruleRow(options.ruleRole)]);                // re-read: rules
}

describe('requestApproval — losing uq_approval_requests_pending', () => {
  beforeEach(() => { vi.clearAllMocks(); savepoint.mockClear(); });

  it("returns the racer's row instead of surfacing the 23505", async () => {
    driver({ racerRole: 'admin', ruleRole: 'admin' });
    const result = await raise();
    expect(result.id).toBe('55555555-5555-5555-5555-555555555555');
    expect(result.status).toBe('pending');
  });

  it('issues the INSERT inside a savepoint, so the conflict does not poison the transaction', async () => {
    driver({ racerRole: 'admin', ruleRole: 'admin' });
    await raise();
    expect(savepoint).toHaveBeenCalledTimes(1);
    // 31 characters is the Postgres identifier limit; a longer name truncates
    // and RELEASE then names a savepoint that does not exist.
    expect(savepoint.mock.calls[0]![0]).toBe('approval_request_insert');
    expect(savepoint.mock.calls[0]![0]!.length).toBeLessThanOrEqual(31);
  });

  it("re-binds the racer's row upwards when the current rule is stricter", async () => {
    // The racer raised under 'manager'; the rules now choose 'owner'.
    driver({ racerRole: 'manager', ruleRole: 'owner' });
    sqlMock.mockResolvedValueOnce([{ ...racedRow('owner'), rule_id: RULE }]); // the rebind UPDATE
    const result = await raise();
    expect(result.requiredRole).toBe('owner');
  });

  it("never re-binds the racer's row downwards", async () => {
    // The racer raised under 'owner'; the rules now choose 'manager' — a rule
    // edit, not a new fact about the document. The row must not move.
    driver({ racerRole: 'owner', ruleRole: 'manager' });
    const result = await raise();
    expect(result.requiredRole).toBe('owner');
    // Six statements: resolve, check ×2, insert, re-read ×2. No seventh UPDATE.
    expect(sqlMock).toHaveBeenCalledTimes(6);
  });

  it('re-throws a 23505 that no re-read can explain', async () => {
    sqlMock.mockReset();
    sqlMock
      .mockResolvedValueOnce([{ amount: '500000', reference: 'AP-1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([ruleRow('admin')])
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce([])            // re-read finds nothing pending
      .mockResolvedValueOnce([ruleRow('admin')]);
    await expect(raise()).rejects.toMatchObject({ code: '23505' });
  });

  it('re-throws any error that is not a unique violation', async () => {
    sqlMock.mockReset();
    sqlMock
      .mockResolvedValueOnce([{ amount: '500000', reference: 'AP-1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([ruleRow('admin')])
      .mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
    await expect(raise()).rejects.toThrow(/deadlock detected/);
  });
});
