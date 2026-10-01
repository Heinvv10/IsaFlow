/**
 * The resolver's "do not cache a fill that a clear overtook" counter is per
 * company. It was process-wide: any tenant clearing its cache (a save, a seed,
 * a merge) made every OTHER tenant's in-flight fill uncached, so each of their
 * postings went back to the database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const pending: Array<(rows: unknown[]) => void> = [];
const sqlMock = vi.fn(() => new Promise<unknown[]>((resolve) => { pending.push(resolve); }));
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...(a as [])) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getSystemAccount, clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const BANK = [{ id: 'bank', account_code: '1110', account_name: 'Bank', account_type: 'asset', account_subtype: 'bank', created_at: null }];

beforeEach(() => { clearSystemAccountCache(); sqlMock.mockClear(); pending.length = 0; });

describe('resolver cache generation', () => {
  it('another company clearing its cache does not stop this company\'s in-flight fill being cached', async () => {
    const first = getSystemAccount('bank', A);         // A's fill is in flight
    clearSystemAccountCache(B);                        // B saves its default accounts
    pending[0]!(BANK);
    expect((await first).accountCode).toBe('1110');
    expect((await getSystemAccount('bank', A)).accountCode).toBe('1110');
    expect(sqlMock).toHaveBeenCalledTimes(1);          // the second read came from the cache
  });

  it('this company\'s own clear, or a clear of everything, still stops the overtaken fill being cached', async () => {
    for (const clear of [() => clearSystemAccountCache(A), () => clearSystemAccountCache()]) {
      sqlMock.mockClear(); pending.length = 0;
      const first = getSystemAccount('bank', A);
      clear();
      pending[0]!(BANK);
      await first;
      const second = getSystemAccount('bank', A);
      pending[1]!(BANK);
      await second;
      expect(sqlMock).toHaveBeenCalledTimes(2);
      clearSystemAccountCache();
    }
  });
});
