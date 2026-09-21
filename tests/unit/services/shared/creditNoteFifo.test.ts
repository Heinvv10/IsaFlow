/**
 * RED — written before creditNoteFifo.ts existed.
 *
 * Two pure rules the rest of the credit-note change hangs off:
 *
 *  1. The status a note lands in is DERIVED from what it consumed, never
 *     written by hand. 'approved' means nothing was applied, 'applied' means
 *     the whole face value was, and 'partially_applied' is the state that had
 *     no name before — the one every statement and ledger reader was forced to
 *     mis-report as one of the other two.
 *  2. Money is compared at a cent. A note that consumed 114.995 of 115 is
 *     fully applied; asserting equality on floats would call it partial.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
// The status recompute is a write of its own and is proved against a real
// database in tests/integration/l2-credit-note-fifo.int.test.ts. Here it is
// stubbed so the assertions below are about the WALK and nothing else.
//
// PARTIAL, and it has to be. Only `recomputeInvoiceStatus` is replaced; the
// rest of the module is spread through from the real one. This file needs the
// spy, but `applyCreditNote` also reaches this module INDIRECTLY — the
// open-document fetchers it calls read the eligible-status list that lives
// here — so a factory returning the spy alone strips an export the code under
// test depends on, and every test in the file dies on "No <export> is defined
// on the mock". That is a semantic conflict rather than a local bug: it does
// not appear until this file meets a branch that moved the list into this
// module, which is exactly why the shape has to be robust rather than
// minimal. Hard-coding the list here instead would be worse — the tests would
// keep passing against statuses the real query had stopped accepting, which is
// the drift a single definition exists to prevent.
vi.mock('@/modules/accounting/services/ar/invoiceStatusRecompute', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/modules/accounting/services/ar/invoiceStatusRecompute')
  >()),
  recomputeInvoiceStatus: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { applyCreditNote, deriveCreditNoteStatus } from '@/modules/accounting/services/shared/creditNoteFifo';

describe('deriveCreditNoteStatus', () => {
  it('is approved when nothing was consumed', () => {
    expect(deriveCreditNoteStatus(0, 115)).toBe('approved');
  });

  it('is applied when the whole face value was consumed', () => {
    expect(deriveCreditNoteStatus(115, 115)).toBe('applied');
  });

  it('is partially_applied between the two', () => {
    expect(deriveCreditNoteStatus(40, 115)).toBe('partially_applied');
  });

  it('treats a sub-cent remainder as fully applied', () => {
    expect(deriveCreditNoteStatus(114.995, 115)).toBe('applied');
  });

  it('treats a sub-cent application as nothing applied', () => {
    expect(deriveCreditNoteStatus(0.004, 115)).toBe('approved');
  });
});

/**
 * The walk itself: which documents it takes, in what order, how much it puts on
 * each, and what it refuses to do.
 *
 * `sql` is mocked and routed by the statement's TEXT, so each case states the
 * database it is walking rather than inheriting one from a fixture. What comes
 * out is the allocation rows written and the money moved, which must always be
 * the same list — that is the invariant the allocation table exists to hold.
 */
describe('applyCreditNote — the oldest-first walk', () => {
  const COMPANY = '11111111-1111-4111-8111-111111111111';
  const NOTE = '22222222-2222-4222-8222-222222222222';
  const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
  const B = 'bbbbbbbb-0000-4000-8000-00000000000b';

  interface Wired {
    rows: [string, number][];
    money: [string, number][];
  }

  /**
   * `candidates` is what the FIFO query offers, IN ORDER (the real one orders by
   * invoice_date). `locked` is what the `FOR UPDATE` re-read then returns — the
   * two are separate on purpose, because the whole point of the lock is that the
   * plan consumes the LOCKED figures and not the candidate query's. `linked`, if
   * given, is the named document and is served by the same locked read.
   *
   * `allocated` is the sum of the note's existing allocation rows, which the
   * applied_amount guard reads before anything is written.
   */
  function wire(
    candidates: [string, number][],
    linked?: { id: string; outstanding: number; status?: string } | null,
    opts: { locked?: [string, number][]; allocated?: number } = {},
  ): Wired {
    const rows: [string, number][] = [];
    const money: [string, number][] = [];
    const lockedRows = opts.locked ?? candidates;
    vi.mocked(sql).mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = (strings as unknown as string[]).join('?');
      if (/SUM\(amount_allocated\)/i.test(text)) {
        return Promise.resolve([{ allocated: opts.allocated ?? 0 }]);
      }
      if (/FOR UPDATE/i.test(text)) {
        const wanted = new Set((values[0] as string[]) ?? []);
        const all: [string, number, string][] = linked
          ? [[linked.id, linked.outstanding, linked.status ?? 'approved'],
             ...lockedRows.map(([id, o]) => [id, o, 'approved'] as [string, number, string])]
          : lockedRows.map(([id, o]) => [id, o, 'approved'] as [string, number, string]);
        return Promise.resolve(all
          .filter(([id]) => wanted.has(id))
          .map(([id, outstanding, status]) => ({ id, status, outstanding })));
      }
      if (/FROM supplier_invoices/i.test(text) && /ORDER BY/i.test(text)) {
        return Promise.resolve(candidates.map(([id, outstanding]) => ({ id, outstanding })));
      }
      if (/INSERT INTO credit_note_allocations/i.test(text)) {
        rows.push([String(values[2]), Number(values[3])]);
        return Promise.resolve([]);
      }
      if (/UPDATE supplier_invoices SET amount_paid/i.test(text)) {
        money.push([String(values[1]), Number(values[0])]);
        return Promise.resolve([{ id: values[1] }]);
      }
      return Promise.resolve([]);
    }) as never);
    return { rows, money };
  }

  const args = (over: Record<string, unknown> = {}) => ({
    companyId: COMPANY, creditNoteId: NOTE, side: 'supplier' as const,
    entityId: 'ssssssss-0000-4000-8000-000000000001',
    totalAmount: 500, linkedInvoiceId: null, autoApply: 'fifo' as const, ...over,
  });

  /**
   * Every `amount_paid` write runs under the BOUNDED invoice row lock, and that
   * helper refuses outright outside a request transaction — correctly, since an
   * unbounded wait there would be a lock that locks nothing. So the walk is
   * driven inside a real `als.run` with a stub client rather than with the lock
   * mocked away: the refusal is part of the contract these tests describe.
   * (The 5s budget and the typed timeout are proved against a real database in
   * tests/integration/k011-invoice-lock-review.int.test.ts.)
   */
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
  function inRequest<T>(fn: () => Promise<T>): Promise<T> {
    return als.run({ client, userId: 'u', companyId: COMPANY, claims: {} } as never, fn);
  }

  beforeEach(() => { vi.clearAllMocks(); client.query.mockResolvedValue({ rows: [] }); });

  it('refuses to move money outside a request transaction', async () => {
    wire([[A, 300]]);
    await expect(applyCreditNote(args()))
      .rejects.toThrow(/requires a request transaction/);
  });

  it('settles the first document in full and part-settles the second', async () => {
    const w = wire([[A, 300], [B, 900]]);
    const out = await inRequest(() => applyCreditNote(args()));
    expect(w.money).toEqual([[A, 300], [B, 200]]);
    expect(out.appliedAmount).toBe(500);
    expect(out.remainder).toBe(0);
  });

  it('writes exactly one allocation row per application, for the money moved', async () => {
    const w = wire([[A, 300], [B, 900]]);
    await inRequest(() => applyCreditNote(args()));
    expect(w.rows).toEqual(w.money);
  });

  it('stops at the credit, never overdrawing a document', async () => {
    const w = wire([[A, 40]]);
    const out = await inRequest(() => applyCreditNote(args({ totalAmount: 100 })));
    expect(w.money).toEqual([[A, 40]]);
    // 60 has nowhere to go and stays on the note as on-account credit.
    expect(out.remainder).toBe(60);
    expect(deriveCreditNoteStatus(out.appliedAmount, 100)).toBe('partially_applied');
  });

  it('caps the LINKED document at its own balance before walking the rest', async () => {
    const w = wire([[B, 900]], { id: A, outstanding: 150 });
    const out = await inRequest(() => applyCreditNote(args({ totalAmount: 500, linkedInvoiceId: A })));
    // 150 to the named document, the other 350 to the next open one.
    expect(w.money).toEqual([[A, 150], [B, 350]]);
    expect(out.appliedAmount).toBe(500);
  });

  it('never allocates to the linked document twice', async () => {
    // The linked document is CAPPED at 300, so 200 of credit is still to place
    // and the walk really runs — and the FIFO query answers with that same
    // document still listed. It must be dropped, or the allocation table's
    // UNIQUE (credit_note_id, invoice_id) refuses the second row mid-write and
    // the 200 lands on a document that has nothing left to settle.
    const w = wire([[A, 300], [B, 900]], { id: A, outstanding: 300 });
    await inRequest(() => applyCreditNote(args({ totalAmount: 500, linkedInvoiceId: A })));
    expect(w.money).toEqual([[A, 300], [B, 200]]);
    expect(w.money.filter(([id]) => id === A)).toHaveLength(1);
  });

  it('applies only to the linked document when auto_apply is "none"', async () => {
    const w = wire([[B, 900]], { id: A, outstanding: 100 });
    const out = await inRequest(() => applyCreditNote(args({ linkedInvoiceId: A, autoApply: 'none' })));
    expect(w.money).toEqual([[A, 100]]);
    expect(out.remainder).toBe(400);
  });

  it('refuses when the linked document has gone, rather than reporting a phantom apply', async () => {
    wire([[B, 900]], null);
    await expect(inRequest(() => applyCreditNote(args({ linkedInvoiceId: A }))))
      .rejects.toThrow(/no longer exists in this company/);
  });

  it('plans against the LOCKED balance, not the one the candidate query returned', async () => {
    // The candidate query says 300 is open; by the time the row lock is taken,
    // a concurrent request has settled all but 100 of it. Planning from the
    // stale figure is what drives amount_paid past total_amount.
    const w = wire([[A, 300]], null, { locked: [[A, 100]] });
    const out = await inRequest(() => applyCreditNote(args({ totalAmount: 500 })));
    expect(w.money).toEqual([[A, 100]]);
    expect(out.remainder).toBe(400);
  });

  it('skips a candidate the lock read cannot see at all', async () => {
    // Soft-deleted, or gone, between the candidate query and the lock. It is a
    // skip rather than a refusal: nothing named it.
    const w = wire([[A, 300], [B, 900]], null, { locked: [[B, 900]] });
    await inRequest(() => applyCreditNote(args({ totalAmount: 500 })));
    expect(w.money).toEqual([[B, 500]]);
  });

  it('refuses when applied_amount and the allocation rows disagree', async () => {
    wire([[A, 300]], null, { allocated: 250 });
    await expect(inRequest(() => applyCreditNote(args({ alreadyApplied: 0 }))))
      .rejects.toThrow(/allocation rows totalling 250/);
  });

  it('accepts a note whose column and rows agree', async () => {
    const w = wire([[A, 300]], null, { allocated: 250 });
    await inRequest(() => applyCreditNote(args({ alreadyApplied: 250 })));
    expect(w.money).toEqual([[A, 300]]);
  });

  it('skips a linked document that has posted nothing, and walks on', async () => {
    // Cancelled between the note's creation, where the link was validated, and
    // its approval. Crediting it would reduce a balance the ledger no longer
    // carries; refusing the whole approval would strand a real credit. So the
    // money goes to the entity's open documents instead.
    const w = wire([[B, 900]], { id: A, outstanding: 1000, status: 'cancelled' });
    const out = await inRequest(() => applyCreditNote(args({ totalAmount: 500, linkedInvoiceId: A })));
    expect(w.money).toEqual([[B, 500]]);
    expect(out.appliedAmount).toBe(500);
  });

  it('leaves the credit on account when the linked document is the only one', async () => {
    const w = wire([], { id: A, outstanding: 1000, status: 'draft' });
    const out = await inRequest(() => applyCreditNote(args({ totalAmount: 500, linkedInvoiceId: A })));
    expect(w.money).toEqual([]);
    expect(out.remainder).toBe(500);
  });

  it('refuses to extend a legacy note whose credit no row accounts for', async () => {
    // applied_amount 300 with no allocation rows: approved before the table
    // existed, with no link the backfill could attribute. Applying it again
    // would write a row for the NEW amount only and make the note permanently
    // uncancellable.
    wire([[A, 900]], null, { allocated: 0 });
    await expect(inRequest(() => applyCreditNote(args({ alreadyApplied: 300 }))))
      .rejects.toThrow(/no allocation rows/);
  });

  it('applies nothing when the entity has no open document', async () => {
    const w = wire([]);
    const out = await inRequest(() => applyCreditNote(args()));
    expect(w.rows).toEqual([]);
    expect(out.appliedAmount).toBe(0);
    expect(out.remainder).toBe(500);
  });

  it('skips the walk entirely when the note names no entity', async () => {
    const w = wire([[A, 900]]);
    const out = await inRequest(() => applyCreditNote(args({ entityId: null })));
    expect(w.money).toEqual([]);
    expect(out.remainder).toBe(500);
  });
});
