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
  });
});
