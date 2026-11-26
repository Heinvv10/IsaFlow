/**
 * Round 25-26 (B25-1, B25-4, R26-5, R26-9): a request with a query IN FLIGHT that long is said every SAGE_WAIT_NOTICE_MS, with who blocks
 * it; time with nothing in flight is never a wait; the blocker belongs to the current wait only. R27-5: a sample that answers after its
 * wait ended is not stored for the next wait (epoch), and a sample with no row clears the blocker. R27-3: the query walks to the root.
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
    expect(w.blocker()).toEqual({ pid: 777, state: 'idle in transaction', app: 'psql', ageS: null, idleMs: null });
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
  it('R27-5 (a): a sample asked during wait A that answers after A ended and B began is not kept for B', async () => {
    vi.useFakeTimers();
    let answer: (rows: unknown[]) => void = () => undefined;
    const pool = { query: vi.fn(() => new Promise((r) => { answer = (rows) => r({ rows }); })) } as never;
    const w = watchWaits(pool);
    w.setPid(42);
    const a = w.begin();
    await vi.advanceTimersByTimeAsync(1_600); // A's sample is asked
    a();
    const b = w.begin(); // B starts before A's sample answers
    answer([{ pid: 777, state: 'active', app: 'psql' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.blocker()).toBeUndefined();
    b();
    w.stop();
  });
  it('R27-5 (b): a sample with no row clears the blocker an earlier sample of the same wait saw', async () => {
    vi.useFakeTimers();
    const rows: unknown[][] = [[{ pid: 777, state: 'active', app: 'psql' }], []];
    const pool = { query: vi.fn(async () => ({ rows: rows.length > 1 ? rows.shift()! : rows[0]! })) } as never;
    const w = watchWaits(pool);
    w.setPid(42);
    const settle = w.begin();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(w.blocker()?.pid).toBe(777);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(w.blocker()).toBeUndefined();
    settle();
    w.stop();
  });
  it('R27-3: the blocker query walks pg_blocking_pids to a holder that is not itself waiting, bounded', () => {
    expect(BLOCKER_SQL).toMatch(/WITH RECURSIVE chain\(pid, depth\)/);
    expect(BLOCKER_SQL).toMatch(/unnest\(pg_blocking_pids\(c\.pid\)\) AS b\(pid\) WHERE c\.depth < 8/);
    expect(BLOCKER_SQL).toMatch(/ORDER BY cardinality\(pg_blocking_pids\(c\.pid\)\) = 0 DESC, c\.depth LIMIT 1$/);
  });
});
