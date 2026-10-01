/**
 * The reversal-chain walks are BOUNDED (W3-01 round 5).
 *
 * A chain is journal → its reversal → a reversal of that. Real rows cannot
 * loop, because a reversal points at an older journal — but bad data or a
 * forged `reversal_of_id` can (A reversed by B and B by A; a journal reversing
 * itself), and nothing stops a chain being very long. Every walk must then
 * end, holding a bounded number of rows, in a REFUSAL: never an unbounded loop
 * or unbounded memory. (An unbounded one hung a whole unit file, and took a
 * worker down with "heap out of memory", while this was being built.)
 *
 * The executor is mocked: the point here is what the code does with rows that
 * loop or never end. That Postgres itself stops is the integration test
 * tests/integration/w3-01-forged-reversal-links.int.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import {
  MAX_CHAIN_JOURNALS,
  findChainRoot,
  lockJournalChain,
  readJournalChain,
} from '@/modules/accounting/services/payroll/payrollJournalChain';

const row = (id: string, depth: number, cents = 100) => ({
  id, depth, entry_number: `JE-${id}`, entry_date: '2026-01-31', status: 'posted', description: 'Payroll run 2026-01',
  gl_account_id: 'acct-1', cents: depth % 2 === 0 ? cents : -cents,
});

describe('lockJournalChain is bounded', () => {
  /** An executor that fails the test instead of hanging it. */
  const counting = (answer: (call: number) => Array<{ id: string }>) => {
    let calls = 0;
    const tx = vi.fn(async () => {
      calls += 1;
      if (calls > 200) throw new Error('lockJournalChain did not terminate'); // a literal: it must not move with the cap
      return answer(calls);
    });
    return { tx, calls: () => calls };
  };

  it('a loop (A reversed by B, B reversed by A): each row is locked once and the walk stops', async () => {
    const { tx, calls } = counting((n) => [{ id: n % 2 === 1 ? 'A' : 'B' }]);
    await lockJournalChain(tx as never, 'c-1', 'A');
    expect(calls()).toBe(3); // A, then B, then A again — already held, so the walk ends
  });

  it('a journal that reverses itself: locked once', async () => {
    const { tx, calls } = counting(() => [{ id: 'A' }]);
    await lockJournalChain(tx as never, 'c-1', 'A');
    expect(calls()).toBe(2);
  });

  it('a chain that never ends stops at the cap, holding no more than MAX_CHAIN_JOURNALS rows', async () => {
    const { tx, calls } = counting((n) => [{ id: `J-${n}` }]); // always one more reversal
    await lockJournalChain(tx as never, 'c-1', 'J-1');
    expect(MAX_CHAIN_JOURNALS).toBe(25); // the cap is pinned: raising it is a decision, not a refactor
    expect(calls()).toBe(25);
  });

  it('an ordinary chain is followed to its end', async () => {
    const answers = [[{ id: 'J-1' }], [{ id: 'J-2' }], [{ id: 'J-3' }], []];
    const tx = vi.fn(async () => answers.shift() ?? []);
    await lockJournalChain(tx as never, 'c-1', 'J-1');
    expect(tx).toHaveBeenCalledTimes(4);
  });
});

describe('readJournalChain refuses a chain that loops or does not end', () => {
  const read = (rows: unknown[]) => readJournalChain('c-1', 'A', (async () => rows) as never);

  it('A reversed by B, B reversed by A — as the capped query returns it', async () => {
    const rows = Array.from({ length: MAX_CHAIN_JOURNALS + 1 }, (_, depth) => row(depth % 2 === 0 ? 'A' : 'B', depth));
    const chain = await read(rows);
    expect(chain).toMatchObject({ broken: true, state: 'unclear' });
    expect(chain!.journals.map((j) => j.id)).toEqual(['A', 'B']); // each once, however often the loop came round
  });

  it('a journal that reverses itself', async () => {
    const chain = await read([row('A', 0), row('A', 1), row('A', 2)]);
    expect(chain).toMatchObject({ broken: true, state: 'unclear' });
    expect(chain!.journals).toHaveLength(1);
  });

  it('a chain as long as the cap is not judged: it may go on', async () => {
    const rows = Array.from({ length: MAX_CHAIN_JOURNALS + 1 }, (_, depth) => row(`J-${depth}`, depth));
    expect(await read(rows)).toMatchObject({ broken: true, state: 'unclear' });
  });

  it('one short of the cap is still an ordinary chain', async () => {
    const rows = Array.from({ length: MAX_CHAIN_JOURNALS }, (_, depth) => row(`J-${depth}`, depth));
    // An even number of mirrored journals nets to zero; an odd number to the first.
    expect(await read(rows)).toMatchObject({ broken: false, state: MAX_CHAIN_JOURNALS % 2 === 0 ? 'out' : 'in_force' });
  });

  it('journal + reversal nets to zero; journal alone is in force', async () => {
    expect(await read([row('A', 0), row('B', 1)])).toMatchObject({ broken: false, state: 'out' });
    expect(await read([row('A', 0)])).toMatchObject({ broken: false, state: 'in_force' });
  });
});

describe('findChainRoot', () => {
  it('is null when no first journal is reached (a loop, or too long): the caller refuses', async () => {
    expect(await findChainRoot('c-1', 'A', (async () => []) as never)).toBeNull();
    expect(await findChainRoot('c-1', 'B', (async () => [{ id: 'A' }]) as never)).toBe('A');
  });
});
