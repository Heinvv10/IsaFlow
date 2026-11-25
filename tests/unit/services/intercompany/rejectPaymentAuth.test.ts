/**
 * Intercompany F, round 1 (AUTH, LOW-4): rejecting a payment message is FINAL, and its authorization lives in `handleService.rejectPayment`,
 * not the route: the receiver's dark flag first, then Approve on Customers & AR (`mayApprove`), each a ConnectionRefusal 403 BEFORE any read
 * or write. Dismiss and restore ask neither (reversible, the message's status only; the route's withWriteAccess and the guard hold the role).
 * The integration twin is payment-r1-handle.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => (strings.join('?').includes('SELECT id, status FROM intercompany_messages')
    ? [{ id: 'm-1', status: 'pending' }] : [{ id: 'm-1' }])),
  approve: vi.fn(async () => true),
  enabled: vi.fn(async () => true),
}));
vi.mock('@/lib/neon', () => ({ sql: m.sql, withSavepoint: async (_n: string, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/approvePermission', () => ({ mayApprove: m.approve }));
vi.mock('@/modules/accounting/services/intercompany/loanClearingGate', () => ({ loanClearingEnabled: m.enabled }));

import { dismissPayment, rejectPayment, restorePayment } from '@/modules/accounting/services/intercompany/handleService';
import { ConnectionRefusal } from '@/modules/accounting/services/intercompany/connectionTypes';

const CO = 'c0000000-0000-4000-8000-000000000001';
const USER = 'u0000000-0000-4000-8000-000000000001';
const updates = () => m.sql.mock.calls.filter(([s]) => (s as TemplateStringsArray).join('?').includes('UPDATE intercompany_messages'));

beforeEach(() => {
  vi.clearAllMocks();
  m.approve.mockResolvedValue(true);
  m.enabled.mockResolvedValue(true);
});

describe('rejectPayment', () => {
  it('without Approve on Customers & AR: 403 before any read or write', async () => {
    m.approve.mockResolvedValue(false);
    const err = await rejectPayment(CO, USER, 'm-1', 'not ours').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionRefusal);
    expect((err as ConnectionRefusal).status).toBe(403);
    expect((err as Error).message).toMatch(/Approve on Customers & AR/);
    expect(m.approve).toHaveBeenCalledWith(CO, USER, 'customers');
    expect(m.sql).not.toHaveBeenCalled();
  });

  it("with the receiver's flag off: 403 first (Approve is not even asked), nothing read or written", async () => {
    m.enabled.mockResolvedValue(false);
    const err = await rejectPayment(CO, USER, 'm-1', 'not ours').catch((e: unknown) => e);
    expect((err as ConnectionRefusal).status).toBe(403);
    expect((err as Error).message).toMatch(/not enabled/);
    expect(m.approve).not.toHaveBeenCalled();
    expect(m.sql).not.toHaveBeenCalled();
  });

  it('with both: the guarded UPDATE runs', async () => {
    await rejectPayment(CO, USER, 'm-1', 'not ours');
    expect(updates()).toHaveLength(1);
  });
});

describe('dismissPayment / restorePayment', () => {
  it('ask neither the flag nor Approve (reversible; the route holds the write role)', async () => {
    m.enabled.mockResolvedValue(false);
    m.approve.mockResolvedValue(false);
    await dismissPayment(CO, 'm-1');
    m.sql.mockImplementationOnce(async () => [{ id: 'm-1', status: 'dismissed' }]);
    await restorePayment(CO, 'm-1');
    expect(m.enabled).not.toHaveBeenCalled();
    expect(m.approve).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(2);
  });
});
