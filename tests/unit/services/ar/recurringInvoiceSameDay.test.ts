/**
 * A recurring run's is_due check and the invoice date it writes are the SAME South African day. CURRENT_DATE (the DB
 * session's) and the app's day disagree between 00:00 and 02:00 SAST: 22:30 UTC on 5 Nov is 00:30 on 6 Nov in
 * Johannesburg. The lock's statement binds the app's day; the run writes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ lockSql: '', lockValues: [] as unknown[] }));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    state.lockSql = strings.join('?'); state.lockValues = values;
    return [{ id: 't1' }];
  }),
}));
vi.mock('@/lib/als', () => ({ als: { getStore: () => ({ client: { query: vi.fn(async () => ({ rows: [] })) } }) }, assertTxUsable: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { lockRecurringTemplate } from '@/modules/accounting/services/ar/recurringInvoiceLock';
import { todayInSast } from '@/lib/saDateParser';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-05T22:30:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('recurring is_due and invoice date share the app day', () => {
  it('at 00:30 SAST the app day is the 6th, and the lock compares next_run_date to it, not to CURRENT_DATE', async () => {
    expect(todayInSast()).toBe('2026-11-06');
    await lockRecurringTemplate('co', 't1');
    expect(state.lockSql).not.toContain('CURRENT_DATE');
    expect(state.lockValues).toContain('2026-11-06');
  });
});
