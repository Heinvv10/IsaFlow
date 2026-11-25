/**
 * Intercompany P2: the two calls the document services make after their own change. They run in a savepoint, never throw, and log a failure
 * AT ERROR with the SQLSTATE only (a re-send is P5; this line is how an unsent or unsynced document is found).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  savepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/neon', () => ({ sql: m.sql, withSavepoint: m.savepoint }));
vi.mock('@/lib/logger', () => ({ log: m.log }));

import { syncGroupRowFor, withdrawForCancelledDocument } from '@/modules/accounting/services/intercompany/mirrorHooks';

beforeEach(() => { vi.clearAllMocks(); });

describe('withdrawForCancelledDocument / syncGroupRowFor', () => {
  it('call their definer inside a savepoint and return what it answered', async () => {
    m.sql.mockResolvedValueOnce([{ n: 2 }]);
    expect(await withdrawForCancelledDocument('co', 'customer_invoice', 'doc')).toBe(2);
    m.sql.mockResolvedValueOnce([{ s: 'matched' }]);
    expect(await syncGroupRowFor('co', 'supplier_invoice', 'doc')).toBe('matched');
    expect(m.savepoint).toHaveBeenCalledTimes(2);
    expect(String((m.sql.mock.calls[0]![0] as string[]).join('?'))).toContain('intercompany_withdraw_for_source');
    expect(String((m.sql.mock.calls[1]![0] as string[]).join('?'))).toContain('intercompany_sync_group_row');
  });

  it('a failure never throws: it is logged at ERROR with the SQLSTATE only and the fallback is returned', async () => {
    m.sql.mockRejectedValueOnce(Object.assign(new Error('relation "x" has secret ids'), { code: '42883' }));
    expect(await withdrawForCancelledDocument('co', 'credit_note', 'doc')).toBe(0);
    m.sql.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '55P03' }));
    expect(await syncGroupRowFor('co', 'credit_note', 'doc')).toBeNull();
    expect(m.log.error).toHaveBeenCalledTimes(2);
    expect(m.log.error).toHaveBeenCalledWith(expect.stringMatching(/withdrawal failed/), { companyId: 'co', id: 'doc', code: '42883' }, 'intercompany');
    expect(JSON.stringify(m.log.error.mock.calls)).not.toMatch(/secret ids/);
  });
});
