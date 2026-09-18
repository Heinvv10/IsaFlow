/**
 * L2 — approving a credit note applies it, oldest document first.
 *
 * Against a real database, because every claim here is about rows: the
 * allocation rows written, the `amount_paid` they move, the statuses
 * `recomputeInvoiceStatus` derives, and whether a cancel puts all of it back
 * EXACTLY as it was. A mocked `sql` can only prove the service issued the
 * statements it was written to issue.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  setupFixture, makeBill, makeInvoice, makeDraftNote, makeApprovedNote,
  billState, invoiceState, noteState, type Fixture,
} from './l2-credit-note-fifo.helpers';
import { als } from '@/lib/als';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { applyCreditNote } from '@/modules/accounting/services/shared/creditNoteFifo';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

/** Allocation rows keyed by document — see the note in 8b about their order. */
function byInvoice(rows: { invoiceId: string; amount: number }[]): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [r.invoiceId, r.amount]));
}

let f: Fixture;

describeIfDb('L2 credit-note FIFO application', () => {
  beforeAll(async () => { f = await setupFixture('L2FIFO'); }, 60000);
  afterAll(async () => { await f.cleanup(); }, 60000);

  it('8a — applies a LINKED note to its own bill, capped at that bill\'s balance', async () => {
    const bill = await makeBill(f, 'L2-8A-1', 400, '2026-03-01');
    const note = await makeDraftNote(f, {
      type: 'supplier', number: 'L2-8A-CN', total: 1000, creditDate: '2026-03-05',
      linkedInvoiceId: bill,
    });

    await f.inTx(() => approveCreditNote(f.company, note, f.user, { autoApply: 'none' }));

    // Capped at 400: the bill cannot absorb more than it owes.
    expect(await billState(f, bill)).toEqual({ paid: 400, status: 'paid' });
    const state = await noteState(f, note);
    expect(state.applied).toBe(400);
    // The remaining 600 is on account, and the status says so.
    expect(state.status).toBe('partially_applied');
    expect(state.allocations).toEqual([{ invoiceId: bill, amount: 400 }]);
  }, 60000);

  it('8b — a note with NO link walks the supplier\'s open bills oldest first', async () => {
    const older = await makeBill(f, 'L2-8B-1', 300, '2026-04-01');
    const newer = await makeBill(f, 'L2-8B-2', 900, '2026-05-01');
    const note = await makeDraftNote(f, {
      type: 'supplier', number: 'L2-8B-CN', total: 500, creditDate: '2026-06-01',
    });

    await f.inTx(() => approveCreditNote(f.company, note, f.user));

    // The older bill is settled in full and the newer one part-settled — never
    // the other way round, which is what the ordering claim is worth testing.
    expect(await billState(f, older)).toEqual({ paid: 300, status: 'paid' });
    expect(await billState(f, newer)).toEqual({ paid: 200, status: 'partially_paid' });
    const state = await noteState(f, note);
    expect(state.status).toBe('applied');
    expect(state.applied).toBe(500);
    // Compared as a SET: the rows all share one transaction timestamp, so their
    // read order is the invoice id's, not the application's. What the FIFO
    // claim rests on is the AMOUNTS above — the older bill fully settled.
    expect(byInvoice(state.allocations)).toEqual({ [older]: 300, [newer]: 200 });
  }, 60000);

  it('8c — a note larger than everything open leaves the excess on account', async () => {
    const bill = await makeBill(f, 'L2-8C-1', 150, '2026-07-01');
    const note = await makeDraftNote(f, {
      type: 'supplier', number: 'L2-8C-CN', total: 1000, creditDate: '2026-07-05',
    });

    await f.inTx(() => approveCreditNote(f.company, note, f.user));

    // The 700 still outstanding on L2-8B-2 is older, so it goes first.
    const state = await noteState(f, note);
    expect(state.status).toBe('partially_applied');
    expect(state.applied).toBe(850);
    expect(state.allocations.map((a) => a.amount).sort((a, b) => a - b)).toEqual([150, 700]);
    expect(await billState(f, bill)).toEqual({ paid: 150, status: 'paid' });
    // 1000 - 850 = 150 stays as on-account credit.
    expect(1000 - state.applied).toBe(150);
  }, 60000);

  it('8d — cancelling restores every document it touched, exactly', async () => {
    const one = await makeBill(f, 'L2-8D-1', 200, '2026-08-01');
    const two = await makeBill(f, 'L2-8D-2', 600, '2026-08-02');
    const note = await makeDraftNote(f, {
      type: 'supplier', number: 'L2-8D-CN', total: 500, creditDate: '2026-08-10',
    });
    const before = [await billState(f, one), await billState(f, two)];

    await f.inTx(() => approveCreditNote(f.company, note, f.user));
    expect(await billState(f, one)).toEqual({ paid: 200, status: 'paid' });
    expect(await billState(f, two)).toEqual({ paid: 300, status: 'partially_paid' });

    await f.inTx(() => cancelCreditNote(f.company, note, f.user, 'raised in error'));

    expect([await billState(f, one), await billState(f, two)]).toEqual(before);
    const state = await noteState(f, note);
    expect(state.status).toBe('cancelled');
    expect(state.applied).toBe(0);
    // The rows go with the money; a surviving row would let a second cancel
    // take the same credit off twice.
    expect(state.allocations).toEqual([]);
  }, 60000);

  it('8b(AR) — a customer note walks the customer\'s open invoices oldest first', async () => {
    const older = await makeInvoice(f, 'L2-AR-1', 250, '2026-04-01');
    const newer = await makeInvoice(f, 'L2-AR-2', 800, '2026-05-01');
    const note = await makeDraftNote(f, {
      type: 'customer', number: 'L2-AR-CN', total: 400, creditDate: '2026-06-01',
    });

    await f.inTx(() => approveCreditNote(f.company, note, f.user));

    expect(await invoiceState(f, older)).toEqual({ paid: 250, status: 'paid' });
    expect(await invoiceState(f, newer)).toEqual({ paid: 150, status: 'partially_paid' });
    const state = await noteState(f, note);
    expect(state.status).toBe('applied');
    expect(byInvoice(state.allocations)).toEqual({ [older]: 250, [newer]: 150 });
  }, 60000);

  it('auto_apply "none" leaves an unlinked note entirely on account', async () => {
    const bill = await makeBill(f, 'L2-NONE-1', 900, '2026-09-01');
    const note = await makeDraftNote(f, {
      type: 'supplier', number: 'L2-NONE-CN', total: 300, creditDate: '2026-09-02',
    });

    await f.inTx(() => approveCreditNote(f.company, note, f.user, { autoApply: 'none' }));

    expect(await billState(f, bill)).toEqual({ paid: 0, status: 'approved' });
    const state = await noteState(f, note);
    expect(state.status).toBe('approved');
    expect(state.applied).toBe(0);
    expect(state.allocations).toEqual([]);
  }, 60000);
});

/**
 * HIGH A — two approvals for one entity, overlapping on one document.
 *
 * Planning from an UNLOCKED balance is a check-then-act pair across requests:
 * both notes read the same 1,000 outstanding and both plan against all of it,
 * so `amount_paid` lands at 1,300 on a 1,000 bill. The interleave is real, not
 * simulated — each approval runs in its own transaction on its own pool client,
 * exactly as withAuth would, and the test waits until the second is genuinely
 * blocked on the first's row lock before letting the first commit.
 */
describeIfDb('L2 concurrent approvals cannot overdraw one document', () => {
  let g: Fixture;
  beforeAll(async () => { g = await setupFixture('L2RACE'); }, 60000);
  afterAll(async () => { await g.cleanup(); }, 60000);

  async function begin(): Promise<{ client: import('pg').PoolClient; pid: number }> {
    const client = await g.pool.connect();
    await client.query('BEGIN');
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    return { client, pid };
  }

  async function waitUntilBlocked(pid: number): Promise<void> {
    for (let i = 0; i < 150; i++) {
      const { rows } = await g.pool.query(
        "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1 AND state='active'", [pid]);
      if (rows[0]?.wait_event_type === 'Lock') return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('the second approval never blocked on the document row lock');
  }

  /**
   * Driven at `applyCreditNote` rather than through `approveCreditNote`, and
   * the reason is worth recording: the full approval mints a journal number
   * first, and THAT is not concurrency-safe — two overlapping approvals collide
   * on `uq_gl_je_company_entry_number` before either reaches the document lock.
   * A pre-existing defect, out of scope here, and it would mask the one this
   * test exists to prove. So the two notes are already approved and only the
   * application races.
   */
  it('serialises on the document and applies exactly what it owes', async () => {
    const bill = await makeBill(g, 'L2R-1', 1000, '2026-03-01');
    const first = await makeApprovedNote(g, {
      type: 'supplier', number: 'L2R-CN-1', total: 500, creditDate: '2026-03-05',
    });
    const second = await makeApprovedNote(g, {
      type: 'supplier', number: 'L2R-CN-2', total: 800, creditDate: '2026-03-06',
    });

    const apply = (c: import('pg').PoolClient, id: string, total: number) => als.run(
      { client: c, userId: g.user, companyId: g.company, claims: {} } as never,
      () => applyCreditNote({
        companyId: g.company, creditNoteId: id, side: 'supplier',
        entityId: g.supplier, totalAmount: total, linkedInvoiceId: null, autoApply: 'fifo',
      }),
    );

    let firstResult: Awaited<ReturnType<typeof applyCreditNote>> | undefined;
    let secondResult: Awaited<ReturnType<typeof applyCreditNote>> | undefined;
    const a = await begin();
    const b = await begin();
    try {
      firstResult = await apply(a.client, first, 500);
      const pending = apply(b.client, second, 800);
      await waitUntilBlocked(b.pid);

      await a.client.query('COMMIT');
      secondResult = await pending;
      await b.client.query('COMMIT');
    } finally {
      a.client.release();
      b.client.release();
    }

    // 500 + 500, never 500 + 800.
    expect(await billState(g, bill)).toEqual({ paid: 1000, status: 'paid' });
    expect(firstResult!.appliedAmount).toBe(500);
    // The second could only place 500 of its 800 once it saw the LOCKED
    // balance; 300 remains on account.
    expect(secondResult!.appliedAmount).toBe(500);
    expect(secondResult!.remainder).toBe(300);
  }, 60000);
});
