/**
 * Intercompany P4-D round 3 (E): the handled page's "Clearing voided" flags are asked one message at a time, each in a savepoint of its own: a
 * check that fails leaves that row voided=false (logged), never a 500 for the page.
 */
import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ fail: 'm-2', log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('FROM customer_payments p')) return [{ id: 'p-1', payment_number: 'CP-1', gl_journal_entry_id: 'je-1' }, { id: 'p-2', payment_number: 'CP-2', gl_journal_entry_id: 'je-2' }];
    if (text.includes('intercompany_allocation_message_live')) {
      if (values[0] === m.fail) throw Object.assign(new Error('boom'), { code: '57014' });
      return [{ clearing_voided: true }];
    }
    return [];
  }),
  withSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/logger', () => ({ log: m.log }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccount: vi.fn() }));

import { withSavepoint } from '@/lib/neon';
import { clearingsOf } from '@/modules/accounting/services/intercompany/allocationClearPreview';

describe('clearingsOf', () => {
  it('a failed check marks only its own row voided=false; the others are judged; each check in its own savepoint', async () => {
    const out = await clearingsOf('co-1', new Map([['m-1', 'p-1'], ['m-2', 'p-2']]));
    expect(out.get('m-1')).toMatchObject({ paymentId: 'p-1', voided: true });
    expect(out.get('m-2')).toMatchObject({ paymentId: 'p-2', voided: false });
    expect(vi.mocked(withSavepoint)).toHaveBeenCalledTimes(2);
    expect(m.log.warn).toHaveBeenCalledTimes(1);
  });
});
