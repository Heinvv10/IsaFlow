/**
 * Intercompany P2, the elimination generator and the mirror's releases take ONE per-group lock (round-4 HIGH 1). The generator checks a row is
 * eligible and inserts its elimination; a cancel releasing the row in between could not see the uncommitted insert, and the generator then
 * committed a standing draft on an unmatched row that a person could post. Now every definer that changes a mirrored row's match state waits for
 * the generator (and the generator for them); a missed release is REPAIRED by the next run; and a post refuses an elimination whose row is no
 * longer carried by both ledgers. Through the real services in separate transactions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { cancelSupplierInvoice } from '../../../src/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { cancelCustomerInvoice } from '../../../src/modules/accounting/services/ar/customerInvoiceCancelService';
import { postEliminationAdjustment } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { EliminationNotCarriedError } from '../../../src/modules/accounting/services/reports/eliminationErrors';
import { asService, co, rawReverseJournal, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const L = makeLedger(pool);
const { groupRow, adjustments, eliminate, approveBill, accepted } = L;
beforeAll(L.setup, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const standing = async () => (await adjustments()).filter((a) => a.status !== 'reversed').length;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A generator transaction that has written its elimination and not yet committed; `finish()` commits it. */
async function heldGenerator() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let written!: () => void;
  const wrote = new Promise<void>((resolve) => { written = resolve; });
  const run = asService(pool, U.ab, co.A, async () => { const out = await eliminate(); written(); await held; return out; });
  await wrote;
  return { finish: async () => { release(); return run; } };
}

describe('a release cannot slip between the generator\'s check and its insert', () => {
  it.each([
    ['the receiver cancels its bill', (m: Awaited<ReturnType<typeof accepted>>) => asService(pool, U.b, co.B, () => cancelSupplierInvoice(co.B, m.bill, U.b))],
    ['the sender cancels its invoice', (m: Awaited<ReturnType<typeof accepted>>) => asService(pool, U.a, co.A, () => cancelCustomerInvoice(co.A, m.inv.id, U.a))],
  ])('%s while the generator is uncommitted: it WAITS for the generator, then releases the row and reverses what the generator wrote', async (_who, cancel) => {
    const m = await accepted();
    await approveBill(m.bill);
    const gen = await heldGenerator();
    let done = false;
    const cancelled = cancel(m).then(() => { done = true; });
    await sleep(500);
    expect(done, 'the cancel is waiting for the generator\'s lock').toBe(false);
    expect((await groupRow()).match_status).toBe('matched');    // (nothing released yet: the cancel has not got past the lock)
    expect(await gen.finish()).toHaveLength(1);
    await cancelled;
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched' });
    expect(await standing()).toBe(0);                            // the draft the generator wrote is reversed, not left to be posted
    expect(await eliminate()).toHaveLength(0);
  });
});

describe('the elimination is checked again at COMMIT', () => {
  it('a reversal that committed while the generator was uncommitted, with no hook and no lock (a failed hook, a statement): the generator\'s commit leaves its elimination reversed', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const gen = await heldGenerator();
    await rawReverseJournal(pool, m.message.source_journal_entry_id);    // committed now; the generator has not committed
    expect(await gen.finish()).toHaveLength(1);
    expect(await standing()).toBe(0);
    expect((await adjustments())[0]).toMatchObject({ status: 'reversed', reversed_reason: expect.stringMatching(/before this was committed/) });
  });
});

describe('a missed release is repaired; a stale elimination is not postable', () => {
  it('a journal reversed with no hook (a failed hook, a reversal made some other way): the next generator run reverses the standing elimination, with when and why', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    expect(await eliminate()).toHaveLength(1);
    await rawReverseJournal(pool, m.message.source_journal_entry_id);
    expect(await groupRow()).toMatchObject({ match_status: 'matched' });   // nobody told the mirror
    expect(await standing()).toBe(1);
    expect(await asService(pool, U.ab, co.A, () => eliminate())).toHaveLength(0);   // (a group writer's run, as a route does)
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched', target_journal_entry_id: null });   // the stale row is released too
    const [a] = await adjustments();
    expect(a).toMatchObject({ status: 'reversed', reversed_reason: expect.stringMatching(/no longer carried by both ledgers/) });
    expect(a!.reversed_at).not.toBeNull();
  });

  it('a POSTED one is reversed by the repair too (it no longer stands)', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const [made] = await eliminate();
    await postEliminationAdjustment(made!.id, co.G);
    await rawReverseJournal(pool, (await groupRow()).first_target_journal_entry_id);
    await eliminate();
    expect((await adjustments())[0]).toMatchObject({ status: 'reversed' });
  });

  it('postEliminationAdjustment refuses a draft whose row is no longer carried (EliminationNotCarriedError), and posts an honest one', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const [made] = await eliminate();
    await rawReverseJournal(pool, m.message.source_journal_entry_id);
    await expect(postEliminationAdjustment(made!.id, co.G)).rejects.toBeInstanceOf(EliminationNotCarriedError);
    expect((await adjustments())[0]).toMatchObject({ status: 'draft' });
    // an elimination of a row that IS carried posts
    await L.reset();
    const ok = await accepted();
    await approveBill(ok.bill);
    const [fine] = await eliminate();
    await postEliminationAdjustment(fine!.id, co.G);
    expect((await adjustments())[0]).toMatchObject({ status: 'posted' });
  });
});
