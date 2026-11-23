/**
 * Intercompany P4-B: the payer's allocation hook. One savepoint per allocation id, never throws, logs a failure by SQLSTATE only, and says
 * which refusals a person must find (a journal the ledger does not carry, and an id the caller just read that is not found, at ERROR; an unposted payment at WARN) and which are
 * silent (no link, not a loan, no connection, a user without an intercompany write role, and `no_session`: a caller outside a request, expected for the categorization sweep).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  savepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/neon', () => ({ sql: m.sql, withSavepoint: m.savepoint }));
vi.mock('@/lib/logger', () => ({ log: m.log }));

import { mirrorAllocations, mirrorBatchAllocations, mirrorPaymentAllocations } from '@/modules/accounting/services/intercompany/allocationOutbox';

const CO = '11111111-1111-4111-8111-111111111111';
const A1 = 'a1111111-1111-4111-8111-111111111111';
const A2 = 'a2222222-2222-4222-8222-222222222222';
const sqlText = (i: number) => (m.sql.mock.calls[i]![0] as string[]).join('?');

beforeEach(() => { vi.clearAllMocks(); });

describe('mirrorAllocations', () => {
  it('calls the definer for each id in its own savepoint', async () => {
    m.sql.mockResolvedValue([{ message_id: 'msg', reason: null, detail: null }]);
    await mirrorAllocations(CO, [A1, A2]);
    expect(m.savepoint).toHaveBeenCalledTimes(2);
    expect(m.savepoint.mock.calls.every((c) => c[0] === 'intercompany_allocation')).toBe(true);
    expect(sqlText(0)).toContain('intercompany_send_for_allocation');
    expect(m.sql.mock.calls.map((c) => c[1])).toEqual([A1, A2]);
    expect(m.log.error).not.toHaveBeenCalled();
  });

  it('does nothing for no ids', async () => {
    await mirrorAllocations(CO, []);
    expect(m.sql).not.toHaveBeenCalled();
    expect(m.savepoint).not.toHaveBeenCalled();
  });

  it('never throws: a failure is logged AT ERROR with the SQLSTATE only, and the next id is still tried', async () => {
    m.sql.mockRejectedValueOnce(Object.assign(new Error('relation "x" names secret ids'), { code: '42883' }));
    m.sql.mockResolvedValueOnce([{ message_id: 'msg', reason: null, detail: null }]);
    await expect(mirrorAllocations(CO, [A1, A2])).resolves.toBeUndefined();
    expect(m.sql).toHaveBeenCalledTimes(2);
    expect(m.log.error).toHaveBeenCalledTimes(1);
    expect(m.log.error).toHaveBeenCalledWith(expect.stringMatching(/allocation/i), { companyId: CO, allocationId: A1, code: '42883' }, 'intercompany');
    expect(JSON.stringify(m.log.error.mock.calls)).not.toMatch(/secret ids/);
  });

  it.each([
    ['no_journal', 'error'], ['not_found', 'error'], ['not_posted', 'warn'],
  ] as const)('a %s answer is logged at %s: nothing re-sends it, so this is how it is found', async (reason, level) => {
    m.sql.mockResolvedValue([{ message_id: null, reason, detail: null }]);
    await mirrorAllocations(CO, [A1]);
    expect(m.log[level]).toHaveBeenCalledWith(expect.stringMatching(/allocation/i), expect.objectContaining({ companyId: CO, allocationId: A1, reason }), 'intercompany');
  });

  it.each(['no_session', 'forbidden', 'no_link', 'not_loan', 'no_connection', 'no_cutover', 'before_cutover', 'already_sent'])('a %s answer is silent', async (reason) => {
    m.sql.mockResolvedValue([{ message_id: null, reason, detail: null }]);
    await mirrorAllocations(CO, [A1]);
    expect(m.log.error).not.toHaveBeenCalled();
    expect(m.log.warn).not.toHaveBeenCalled();
  });
});

describe('mirrorPaymentAllocations', () => {
  it('reads the allocation ids of the company\'s own payments and mirrors them', async () => {
    m.sql.mockResolvedValueOnce([{ id: A1 }, { id: A2 }]);
    m.sql.mockResolvedValue([{ message_id: 'msg', reason: null, detail: null }]);
    await mirrorPaymentAllocations(CO, ['p1', 'p2']);
    const read = sqlText(0);
    expect(read).toMatch(/payment_allocations/);
    expect(read).toMatch(/company_id/);
    expect(m.sql.mock.calls.slice(1).map((c) => c[1])).toEqual([A1, A2]);
  });

  it('never throws when the read fails, and does nothing for no payments', async () => {
    m.sql.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57014' }));
    await expect(mirrorPaymentAllocations(CO, ['p1'])).resolves.toBeUndefined();
    expect(m.log.error).toHaveBeenCalledWith(expect.stringMatching(/allocation/i), expect.objectContaining({ code: '57014' }), 'intercompany');
    vi.clearAllMocks();
    await mirrorPaymentAllocations(CO, []);
    expect(m.sql).not.toHaveBeenCalled();
  });
});

describe('mirrorBatchAllocations', () => {
  it('reads the allocation ids of the company\'s own batch members and mirrors them; a failed read is logged and does not throw', async () => {
    m.sql.mockResolvedValueOnce([{ id: A1 }]);
    m.sql.mockResolvedValue([{ message_id: 'msg', reason: null, detail: null }]);
    await mirrorBatchAllocations(CO, 'batch');
    const read = sqlText(0);
    expect(read).toMatch(/sp\.batch_id/);
    expect(read).toMatch(/sp\.company_id/);
    expect(m.sql.mock.calls[1]![1]).toBe(A1);
    vi.clearAllMocks();
    m.sql.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '40P01' }));
    await expect(mirrorBatchAllocations(CO, 'batch')).resolves.toBeUndefined();
    expect(m.log.error).toHaveBeenCalledWith(expect.stringMatching(/allocation/i), { companyId: CO, code: '40P01' }, 'intercompany');
  });
});
