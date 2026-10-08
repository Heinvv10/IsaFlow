/**
 * bank/transferDuplicateGuard (brk-nrfa M1, rev-nrfa LOW-1/2/3): which existing ledger rows refuse a transfer, and the
 * direction each query is given. Postgres semantics are proven in tests/integration/bank-transfers-revive.int.test.ts;
 * this pins the branches and the bound values without a database (the integration file skips on GitHub).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sql = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql }));

import { assertNoDuplicateTransfer, findTransferRecordedFromStatement } from '@/modules/accounting/services/bank/transferDuplicateGuard';

const CO = 'c0000000-0000-4000-8000-000000000001';
const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
/** The values bound into the n-th sql call (a tagged template: [strings, ...values]). */
const values = (n: number) => sql.mock.calls[n]!.slice(1);
const text = (n: number) => (sql.mock.calls[n]![0] as string[]).join('?');

beforeEach(() => { sql.mockReset(); sql.mockResolvedValue([]); });

describe('assertNoDuplicateTransfer', () => {
  it("passes when neither the other bank's line nor a typed journal holds the movement", async () => {
    await expect(assertNoDuplicateTransfer(CO, A, B, -1000, '2026-04-20')).resolves.toBeUndefined();
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it('refuses when the other bank already allocated the transfer back (and skips the journal read)', async () => {
    sql.mockResolvedValueOnce([{ id: 'line' }]);
    await expect(assertNoDuplicateTransfer(CO, A, B, -1000, '2026-04-20')).rejects.toThrow(/already exists/);
    expect(sql).toHaveBeenCalledTimes(1);
    expect(values(0)).toContain(1000); // the other bank's line is the opposite sign
  });

  it('refuses when a typed transfer journal holds it', async () => {
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'je' }]);
    await expect(assertNoDuplicateTransfer(CO, A, B, 1000, '2026-04-20')).rejects.toThrow(/Match the existing journal/);
  });

  it.each([[-1000, false], [1000, true]])('a line of %d asks for the journal in its own direction (into this bank: %j)',
    async (amount, into) => {
      await assertNoDuplicateTransfer(CO, A, B, amount, '2026-04-20');
      // This bank's leg, then the counterparty's: opposite sides (rev-nrfa round 3 LOW-2).
      expect(text(1)).toMatch(/CASE WHEN \?::BOOLEAN THEN jl\.debit ELSE jl\.credit END[\s\S]*CASE WHEN \?::BOOLEAN THEN jl\.credit ELSE jl\.debit END/);
      expect(values(1)).toContain(into);
      expect(values(1)).toContain(1000);
    });

  // brk-nrfa round 3: only a TYPED journal (reference set) counts, within five days, and a journal an ordinary match
  // already tied to a line on this bank is linked.
  it('asks only for typed journals within five days, and treats an ordinary match as linked', async () => {
    await assertNoDuplicateTransfer(CO, A, B, -1000, '2026-04-20');
    expect(text(1)).toMatch(/je\.reference IS NOT NULL/);
    expect(text(1)).toMatch(/INTERVAL '5 days'/);
    expect(text(1)).toMatch(/ml\.id = bt\.matched_journal_line_id/);
  });

  // brk-nrfa round 5 F1: a line's transfer pointer survives an unmatch, so neither arm's consumption test may read it.
  it('counts a line on this bank as pairing the journal only by its match, never by its transfer pointer', async () => {
    await assertNoDuplicateTransfer(CO, A, B, -1000, '2026-04-20');
    const consumption = (n: number) => text(n).slice(text(n).indexOf('NOT EXISTS'));
    expect(consumption(0)).not.toMatch(/own\.transfer_journal_entry_id/);
    expect(consumption(1)).not.toMatch(/bt\.transfer_journal_entry_id/);
    // sec-nrfa round 5 L1: matched to this bank's own leg, on its sign's side, for its amount — not any leg at all.
    for (const [n, t] of [[0, 'own'], [1, 'bt']] as const) {
      expect(consumption(n)).toContain(`ml.id = ${t}.matched_journal_line_id`);
      expect(consumption(n)).toContain(`ml.gl_account_id = ${t}.bank_account_id`);
      // ...a leg of THIS journal: any line matched anywhere else on the bank would otherwise switch the guard off.
      expect(consumption(n)).toContain(n === 0 ? 'ml.journal_entry_id = bank_transactions.transfer_journal_entry_id'
        : 'ml.journal_entry_id = je.id');
      expect(consumption(n)).toContain(`(CASE WHEN ${t}.amount > 0 THEN ml.debit ELSE ml.credit END) = ABS(${t}.amount)`);
    }
    // brk-nrfa round 6 M1: only an imported or feed line on this bank pairs the journal, never a hand-keyed one.
    for (const [n, t] of [[0, 'own'], [1, 'bt']] as const) {
      expect(consumption(n)).toContain(`(${t}.import_batch_id IS NOT NULL OR ${t}.bank_feed_connection_id IS NOT NULL)`);
    }
    // brk-nrfa round 6 L1: arm 1's counterparty line is live and matched to its leg of a journal that stands.
    const outer = text(0).slice(0, text(0).indexOf('NOT EXISTS'));
    expect(outer).toMatch(/AND status IN \('allocated', 'matched', 'reconciled'\)/);
    expect(outer).toContain('tl.id = bank_transactions.matched_journal_line_id');
    // sec-nrfa round 6: "not reversed" is read from the chain (an even count of posted reversals stands), and a pairing
    // line is of the same movement — within five days.
    expect(outer).toMatch(/tj\.reversed_at IS NULL OR \(SELECT MAX\(ch\.d\) % 2 = 0[\s\S]*WITH RECURSIVE/);
    expect(text(1)).toMatch(/je\.reversed_at IS NULL OR \(SELECT MAX\(ch\.d\) % 2 = 0[\s\S]*WITH RECURSIVE/);
    expect(consumption(0)).toContain("own.transaction_date BETWEEN (bank_transactions.transaction_date - INTERVAL '5 days')");
    expect(consumption(1)).toContain("bt.transaction_date BETWEEN (je.entry_date - INTERVAL '5 days')");
  });
});

describe('findTransferRecordedFromStatement', () => {
  it('names the journal the statement recorded, else null', async () => {
    sql.mockResolvedValueOnce([{ entry_number: 'JE-2026-00042' }]);
    await expect(findTransferRecordedFromStatement(CO, A, B, 1000, '2026-04-20')).resolves.toBe('JE-2026-00042');
    await expect(findTransferRecordedFromStatement(CO, A, B, 1000, '2026-04-20')).resolves.toBeNull();
    // DR the destination, CR the source, and only with a live statement line behind it.
    expect(text(0)).toMatch(/gl_account_id = \?::UUID AND jl\.debit = \?/);
    expect(values(0).slice(0, 6)).toEqual([CO, '2026-04-20', '2026-04-20', B, 1000, A]);
    expect(text(0)).toMatch(/bt\.status IN \('allocated', 'matched', 'reconciled'\) AND bt\.feed_state = 'posted'/);
    // Only a journal the statement created (no reference); a typed one, even matched, never blocks another typed one.
    expect(text(0)).toMatch(/je\.reference IS NULL/);
    expect(text(0)).toMatch(/INTERVAL '5 days'/);
  });

  // sec-nrfa round 4 M1, brk-nrfa round 5 F3: evidence is an imported or feed line MATCHED to the journal's leg.
  it('asks for an imported or feed line matched to the leg, not one merely pointing at the journal', async () => {
    await findTransferRecordedFromStatement(CO, A, B, 1000, '2026-04-20');
    expect(text(0)).toMatch(/bl\.id = bt\.matched_journal_line_id/);
    expect(text(0)).toMatch(/bt\.import_batch_id IS NOT NULL OR bt\.bank_feed_connection_id IS NOT NULL/);
    expect(text(0)).toMatch(/je\.reversed_at IS NULL OR \(SELECT MAX\(ch\.d\) % 2 = 0[\s\S]*WITH RECURSIVE/); // sec-nrfa r6 M1
  });
});
