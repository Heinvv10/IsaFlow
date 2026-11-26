/**
 * Round 25-26 (B25-1, B25-4, R26-5, R26-9): a request with a query IN FLIGHT that long is said every SAGE_WAIT_NOTICE_MS, with who blocks
 * it; time with nothing in flight is never a wait; the blocker belongs to the current wait only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLOCKER_SQL, SAGE_WAIT_NOTICE_MS, watchWaits } from '@/modules/accounting/services/sage-migration/sageWaitWatch';

vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
afterEach(() => { vi.useRealTimers(); });

const blockingPool = (asked: unknown[]) => ({ query: vi.fn(async (t: string, v: unknown[]) => { asked.push([t, v[0]]); return { rows: [{ pid: 777, state: 'idle in transaction', app: 'psql' }] }; }) }) as never;

describe('watchWaits', () => {
  it('a query in flight: said every 5 s with the blocking backend, asked by the request\'s own pid; settling it starts over and clears the blocker', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const asked: unknown[] = [];
    const w = watchWaits(blockingPool(asked), (l) => lines.push(l));
    w.setPid(42);
    const settle = w.begin();
    await vi.advanceTimersByTimeAsync(SAGE_WAIT_NOTICE_MS - 600);
    expect(lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(700);
    expect(lines).toEqual(['a database request has had no answer for 5 s; it is blocked by backend pid 777']);
    await vi.advanceTimersByTimeAsync(SAGE_WAIT_NOTICE_MS);
    expect(lines.at(-1)).toBe('a database request has had no answer for 10 s; it is blocked by backend pid 777');
    expect(asked[0]).toEqual([BLOCKER_SQL, 42]);
    expect(w.blocker()).toEqual({ pid: 777, state: 'idle in transaction', app: 'psql' });
    settle();
    expect(w.blocker()).toBeUndefined(); // R26-5: a finished wait's blocker is not kept for the next
    w.stop();
  });
  it('R26-9: nothing in flight (non-database work) is never a wait: no notice, no sample', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const asked: unknown[] = [];
    const w = watchWaits(blockingPool(asked), (l) => lines.push(l));
    w.setPid(42);
    w.begin()(); // a query that answered at once
    await vi.advanceTimersByTimeAsync(SAGE_WAIT_NOTICE_MS * 3);
    expect([lines, asked]).toEqual([[], []]);
    w.stop();
  });
  it('before the pid is known (the connect itself waits): said, with no blocker asked for', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const asked: unknown[] = [];
    const w = watchWaits(blockingPool(asked), (l) => lines.push(l));
    const connecting = w.begin();
    await vi.advanceTimersByTimeAsync(SAGE_WAIT_NOTICE_MS + 100);
    expect(lines).toEqual(['a database request has had no answer for 5 s']);
    expect(asked).toEqual([]);
    connecting();
    w.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
