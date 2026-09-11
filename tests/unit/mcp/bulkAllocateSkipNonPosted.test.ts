/**
 * A-4 — the bulk allocate pre-check reads feed_state, and a pending or removed
 * feed row becomes a per-line SKIP before anything is written, rather than a
 * BankAllocationRefusal thrown mid-batch (which unwinds every good line).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { findBankTransactionAllocationStates } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import { partitionAllocationLines } from '@/lib/mcp/tools/bulkAllocationSkip';
import type { ResolvedLine } from '@/lib/mcp/tools/bulkAllocationPrepare';

const TX = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const line = (index: number, txId: string) =>
  ({ index, txId, line: { allocType: 'account', contraAccountId: 'acc' } }) as unknown as ResolvedLine;
const row = (n: number, feed_state: string) =>
  ({ id: TX(n), status: 'imported', matched_journal_line_id: null, amount: '-100', feed_state });

beforeEach(() => sqlMock.mockReset());

describe('bulk allocate — non-posted feed rows are skipped pre-write', () => {
  it('findBankTransactionAllocationStates carries feed_state', async () => {
    sqlMock.mockResolvedValueOnce([row(1, 'removed')]);
    const states = await findBankTransactionAllocationStates('co', [TX(1)]);
    expect(states.get(TX(1))).toMatchObject({ status: 'imported', feedState: 'removed' });
  });

  it('skips pending and removed rows with a reason, and keeps the posted one', async () => {
    sqlMock.mockResolvedValueOnce([row(1, 'posted'), row(2, 'pending'), row(3, 'removed')]);
    const { postable, skipped } = await partitionAllocationLines('co', [line(0, TX(1)), line(1, TX(2)), line(2, TX(3))]);
    expect(postable.map((p) => p.txId)).toEqual([TX(1)]);
    expect(skipped).toEqual([
      { index: 1, transaction_id: TX(2), reason: 'pending at the bank' },
      { index: 2, transaction_id: TX(3), reason: 'removed by the bank' },
    ]);
    // One read, no write.
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});
