import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/neon')>();
  return { ...actual, sql: vi.fn(async () => [] as unknown[]), withTransaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(vi.fn())) };
});

import { sql } from '@/lib/neon';
import { enterFakeRequestCtx } from '../helpers/requestCtx';
import { allocateTransaction, splitAllocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { excludeTransaction, matchTransaction, unmatchTransaction } from '@/modules/accounting/services/bank/bankTxStatusMutations';
import { isBankTransactionNotPosted } from '@/modules/accounting/services/bank/bankFeedStateGuard';
import { isBankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';

const CO = '00000000-0000-0000-0000-00000000000c';
const TX = '00000000-0000-0000-0000-0000000000a1';
const pendingRow = { id: TX, company_id: CO, status: 'imported', amount: '-100', feed_state: 'pending', matched_journal_line_id: null };

beforeEach(() => {
  vi.mocked(sql).mockReset();
  vi.mocked(sql).mockImplementation(async () => [pendingRow] as unknown[]);
  enterFakeRequestCtx();
});

describe('locked mutators refuse a pending feed row before writing', () => {
  it.each([
    ['allocate', () => allocateTransaction(CO, TX, 'gl-1', 'user-1')],
    ['split', () => splitAllocateTransaction(CO, TX, [{ glAccountId: 'gl-1', amount: 100 }] as never, 'user-1')],
    ['match', () => matchTransaction(CO, TX, 'line-1')],
    ['unmatch', () => unmatchTransaction(CO, TX)],
    ['exclude', () => excludeTransaction(CO, TX, 'r')],
  ])('%s', async (_verb, run) => {
    let caught: unknown;
    try { await run(); } catch (e) { caught = e; }
    expect(isBankTransactionNotPosted(caught) || isBankAllocationRefusal(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/pending at the bank/);
    // Only the lock SELECT ran; no INSERT/UPDATE was issued. (The lock SELECT
    // itself carries a `FOR UPDATE` clause, so the write-keyword check must not
    // trip on that — hence the negative lookbehind on `UPDATE`.)
    const texts = vi.mocked(sql).mock.calls.map((c) => (c[0] as unknown as string[]).join('?'));
    expect(texts.some((t) => /\bINSERT\b|(?<!FOR )\bUPDATE\b/i.test(t))).toBe(false);
  });
});
