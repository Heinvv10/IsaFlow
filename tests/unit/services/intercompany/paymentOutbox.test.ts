/**
 * Intercompany F (k) L-4 / M-4 / (l) MED-3: the hook asks D3 (allocation) first, D1 (payment) only when D3 answers `not_loan`, D1 in a
 * savepoint of its own. D1's reasons are silent except not_found / no_journal / ambiguous / superseded (error) and not_posted / no_cutover /
 * before_cutover (warn); a 23505 is info `other_kind_sent`; a lock timeout is error with its SQLSTATE; nothing throws.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  savepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  enabled: vi.fn(async (_companyId: string) => true),
}));
vi.mock('@/lib/neon', () => ({ sql: m.sql, withSavepoint: m.savepoint }));
vi.mock('@/lib/logger', () => ({ log: m.log }));
vi.mock('@/modules/accounting/services/intercompany/loanClearingGate', () => ({ loanClearingEnabled: m.enabled }));

import { mirrorAllocations } from '@/modules/accounting/services/intercompany/allocationOutbox';

const CO = '11111111-1111-4111-8111-111111111111';
const A1 = 'a1111111-1111-4111-8111-111111111111';
const text = (i: number) => (m.sql.mock.calls[i]![0] as string[]).join('?');
const answers = (...rows: unknown[]) => { for (const r of rows) m.sql.mockResolvedValueOnce([r] as unknown[]); };

beforeEach(() => { vi.clearAllMocks(); m.enabled.mockResolvedValue(true); m.sql.mockResolvedValue([]); });

describe('the payment kind in the hook', () => {
  it('D3 first; D1 only after not_loan, in its own savepoint', async () => {
    answers({ message_id: null, reason: 'not_loan' }, { message_id: 'pm', reason: null });
    await mirrorAllocations(CO, [A1]);
    expect(text(0)).toContain('intercompany_send_for_allocation');
    expect(text(1)).toContain('intercompany_send_for_payment');
    expect(m.savepoint.mock.calls.map((c) => c[0])).toEqual(['intercompany_allocation', 'intercompany_payment']);
    expect(m.log.info).toHaveBeenCalledWith(expect.stringMatching(/payment message sent/i), expect.objectContaining({ messageId: 'pm' }), 'intercompany');
  });

  it.each(['no_link', 'no_connection', 'forbidden', 'already_sent', 'not_enabled', 'no_session'])('D3 %s: D1 is not asked', async (reason) => {
    answers({ message_id: null, reason });
    await mirrorAllocations(CO, [A1]);
    expect(m.sql).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not_found', 'error'], ['no_journal', 'error'], ['ambiguous', 'error'], ['superseded', 'error'],
    ['not_posted', 'warn'], ['no_cutover', 'warn'], ['before_cutover', 'warn'],
  ] as const)('D1 %s is logged at %s', async (reason, level) => {
    answers({ message_id: null, reason: 'not_loan' }, { message_id: null, reason });
    await mirrorAllocations(CO, [A1]);
    expect(m.log[level]).toHaveBeenCalledWith(expect.stringMatching(/payment message not sent/i), expect.objectContaining({ reason }), 'intercompany');
  });

  it.each(['not_partner_supplier', 'not_linked', 'not_cash', 'not_group', 'no_connection', 'through_loan', 'allocation_sent', 'already_sent', 'forbidden', 'not_enabled'])(
    'D1 %s is silent', async (reason) => {
      answers({ message_id: null, reason: 'not_loan' }, { message_id: null, reason });
      await mirrorAllocations(CO, [A1]);
      expect(m.log.error).not.toHaveBeenCalled();
      expect(m.log.warn).not.toHaveBeenCalled();
    });

  it('a 23505 from either definer is info other_kind_sent, never an error', async () => {
    m.sql.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    await mirrorAllocations(CO, [A1]);
    answers({ message_id: null, reason: 'not_loan' });
    m.sql.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    await mirrorAllocations(CO, [A1]);
    expect(m.log.error).not.toHaveBeenCalled();
    expect(m.log.info.mock.calls.filter((c) => (c[1] as { reason?: string }).reason === 'other_kind_sent')).toHaveLength(2);
  });

  it('a D1 lock timeout is error with 55P03, and never throws', async () => {
    answers({ message_id: null, reason: 'not_loan' });
    m.sql.mockRejectedValueOnce(Object.assign(new Error('lock timeout names ids'), { code: '55P03' }));
    await expect(mirrorAllocations(CO, [A1])).resolves.toBeUndefined();
    expect(m.log.error).toHaveBeenCalledWith(expect.stringMatching(/payment message not written/i), expect.objectContaining({ code: '55P03' }), 'intercompany');
    expect(JSON.stringify(m.log.error.mock.calls)).not.toContain('names ids');
  });
});
