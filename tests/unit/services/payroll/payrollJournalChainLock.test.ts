/**
 * lockJournalChain walks journal → reversal → reversal of that, locking each.
 * A reversal always points at an OLDER journal, so real rows cannot loop — but
 * the walk must end even if they did (or a mocked executor answers the same
 * row forever, which hung a whole unit file in W3-01 round 5).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { lockJournalChain } from '@/modules/accounting/services/payroll/payrollJournalChain';

describe('lockJournalChain', () => {
  it('locks each journal once and stops, even when the rows answer in a loop', async () => {
    let calls = 0;
    const tx = vi.fn(async () => {
      calls += 1;
      if (calls > 20) throw new Error('lockJournalChain did not terminate');
      return [{ id: 'j-1' }];
    });
    await lockJournalChain(tx as never, 'c-1', 'j-1');
    expect(calls).toBe(2); // the root, then one look for its reversals — which finds only what is already held
  });

  it('follows the chain to its end', async () => {
    const answers = [[{ id: 'j-1' }], [{ id: 'j-2' }], [{ id: 'j-3' }], []];
    const tx = vi.fn(async () => answers.shift() ?? []);
    await lockJournalChain(tx as never, 'c-1', 'j-1');
    expect(tx).toHaveBeenCalledTimes(4);
  });
});
