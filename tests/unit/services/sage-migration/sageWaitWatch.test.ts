/** Round 25 (B25-1, B25-4): a request with no answer is said every SAGE_WAIT_NOTICE_MS, with who blocks it; the blocker is kept. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAGE_WAIT_NOTICE_MS, watchWaits } from '@/modules/accounting/services/sage-migration/sageWaitWatch';

vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
afterEach(() => { vi.useRealTimers(); });

describe('watchWaits', () => {
  it('says a wait every 5 s with the blocking backend; a touch starts it over; the blocker is kept for a lock timeout', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const asked: unknown[] = [];
    const pool = { query: vi.fn(async (_t: string, v: unknown[]) => { asked.push(v[0]); return { rows: [{ p: [777] }] }; }) } as never;
    const w = watchWaits(pool, 42, (l) => lines.push(l));
    await vi.advanceTimersByTimeAsync(SAGE_WAIT_NOTICE_MS - 600);
    expect(lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(700);
    expect(lines).toEqual(['a database request has had no answer for 5 s; it is blocked by backend pid 777']);
    await vi.advanceTimersByTimeAsync(SAGE_WAIT_NOTICE_MS);
    expect(lines.at(-1)).toBe('a database request has had no answer for 10 s; it is blocked by backend pid 777');
    expect(asked[0]).toBe(42);
    expect(w.blocker()).toBe(777);
    w.touch();
    await vi.advanceTimersByTimeAsync(SAGE_WAIT_NOTICE_MS - 600);
    expect(lines).toHaveLength(2);
    w.stop();
    await vi.advanceTimersByTimeAsync(SAGE_WAIT_NOTICE_MS * 3);
    expect(lines).toHaveLength(2);
  });
  it('without a pid (or a pool that cannot query) it still says the wait, with no blocker', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const w = watchWaits({} as never, undefined, (l) => lines.push(l));
    await vi.advanceTimersByTimeAsync(SAGE_WAIT_NOTICE_MS + 100);
    expect(lines).toEqual(['a database request has had no answer for 5 s']);
    w.stop();
  });
});
