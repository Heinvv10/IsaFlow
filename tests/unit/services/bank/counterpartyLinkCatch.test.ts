/**
 * allocateTransaction's counterparty auto-link catch must not swallow a
 * transaction-level failure.
 *
 * The auto-link is a nicety: if the opposite bank's statement has no matching
 * row, the allocation is still correct, so the catch logs a warning and carries
 * on. But 40P01 (deadlock), 40001 (serialization failure) and 25P02 (current
 * transaction is aborted) kill the whole request transaction — every statement
 * after them raises 25P02 and nothing can commit. Swallowed, the handler runs
 * to completion and returns a journal id for a journal that will never exist.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const journalMocks = vi.hoisted(() => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
  reverseJournalEntry: vi.fn(),
}));

vi.mock('@/lib/neon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/neon')>();
  return {
    sql: vi.fn(async () => [] as unknown[]),
    fmtDate: actual.fmtDate,
    withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(vi.fn(async () => []))),
  };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => journalMocks);
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn(async () => 'ffffffff-0000-0000-0000-ffffffffffff'),
}));
vi.mock('@/modules/accounting/services/capture/fourWayMatchService', () => ({
  recordPaymentMatch: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { enterFakeRequestCtx } from '../../helpers/requestCtx';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const TX_ID = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
const CONTRA_ID = 'cccccccc-0000-0000-0000-cccccccccccc';
const USER_ID = 'dddddddd-0000-0000-0000-dddddddddddd';

const TX_ROW = {
  id: TX_ID, company_id: COMPANY_ID, status: 'imported',
  bank_account_id: 'eeeeeeee-0000-0000-0000-eeeeeeeeeeee',
  transaction_date: '2026-08-01', amount: -500, description: 'Transfer out',
  matched_journal_line_id: null,
};

/**
 * Drive a transfer allocation up to the counterparty auto-link, then make the
 * link's first query fail with `code`.
 */
async function allocateTransferFailingLinkWith(code: string | undefined) {
  const err = code ? Object.assign(new Error(`pg ${code}`), { code }) : new Error('no code');
  vi.mocked(sql).mockImplementation((async (strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings);
    // The locked read and the final re-read of the row it returns.
    if (text.includes('SELECT * FROM bank_transactions')) return [TX_ROW];
    if (text.includes('account_subtype')) return [{ id: CONTRA_ID, account_subtype: 'bank', account_code: '1010', account_name: 'Bank B' }];
    // The auto-link's candidate query specifically — the duplicate-transfer
    // guard earlier in the function also mentions counterparty_account_id, but
    // it sits OUTSIDE the try and is meant to reject.
    if (text.includes('ORDER BY ABS(')) throw err;
    return [];
  }) as never);

  return allocateTransaction(
    COMPANY_ID, TX_ID, CONTRA_ID, USER_ID, 'Transfer', 'transfer',
  );
}

describe('allocateTransaction — counterparty auto-link failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enterFakeRequestCtx();
    journalMocks.createJournalEntry.mockResolvedValue({ id: 'je-1' });
    journalMocks.postJournalEntry.mockResolvedValue({ id: 'je-1', status: 'posted' });
  });

  for (const code of ['40P01', '40001', '25P02']) {
    it(`rethrows ${code} — the transaction is dead, nothing after it can commit`, async () => {
      await expect(allocateTransferFailingLinkWith(code)).rejects.toThrow(`pg ${code}`);
      expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(
        expect.stringContaining('auto-link'), expect.anything(), expect.anything(),
      );
    });
  }

  it('still swallows an ordinary link failure — the allocation itself is fine', async () => {
    await expect(allocateTransferFailingLinkWith('42703')).resolves.toBeDefined();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('auto-link'), expect.anything(), expect.anything(),
    );
  });
});
