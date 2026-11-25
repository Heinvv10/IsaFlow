/**
 * Intercompany P2, round 21:
 *  M2  a row the generator leaves to mirroring says WHEN the mirror eliminates it (the facts' wording: after the period, with the date), not
 *      "eliminated by mirroring" for every linked row;
 *  L1  the stated limit of the derivation: the reversal chains are dated, the reference data is read as it is today (an unbound row's
 *      receiver journal is judged against today's supplier link, so a past period moves when it is edited);
 *  L6  the stated limit of accept against a sender's concurrent cancel: an accept that holds the message row longer than the cancel's hook
 *      waits (2 s) commits a draft for a sale the sender has cancelled, and the message is not stamped (what the system still says).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { createIntercompanyTransaction } from '../../../src/modules/accounting/services/reports/intercompanyService';
import { autoGenerateEliminations, type SkippedEliminationRow } from '../../../src/modules/accounting/services/reports/eliminationGenerator';
import { asService, co, inbox, party, sentInvoice, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';
import { asAppUser, withoutTrigger } from './intercompany.session';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
beforeAll(async () => { await L.setup(); await L.monthly(co.A, 2026); await L.monthly(co.B, 2026); }, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const conn = async () => (await pool.query("SELECT id FROM intercompany_connections WHERE status <> 'revoked' AND $1 IN (company_low_id, company_high_id) AND $2 IN (company_low_id, company_high_id)", [co.A, co.B])).rows[0].id as string;
async function turnOn(cutover: string, since = '2026-01-01') {
  const id = await conn();
  await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connection_sides SET supplier_id = $2 WHERE connection_id = $1 AND company_id = $3', [id, party.aSupplier, co.A]), true);
  await asAppUser(pool, U.ab, co.B, (q) => q.query('UPDATE intercompany_connection_sides SET customer_id = $2 WHERE connection_id = $1 AND company_id = $3', [id, party.bCustomer, co.B]), true);
  await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connections SET cutover_date = $2 WHERE id = $1', [id, cutover]), true);
  await withoutTrigger(pool, 'intercompany_connection_sides', 'trg_intercompany_sides_auto_since', async (q) => {
    await q.query('ALTER TABLE intercompany_connection_sides DISABLE TRIGGER trg_intercompany_sides_guard');
    await q.query("UPDATE intercompany_connection_sides SET mirroring_since = ($2 || ' 00:00+02')::timestamptz WHERE connection_id = $1", [id, since]);
    await q.query('ALTER TABLE intercompany_connection_sides ENABLE ALWAYS TRIGGER trg_intercompany_sides_guard');
  });
}
const redate = (bill: string, date: string) => pool.query('UPDATE supplier_invoices SET invoice_date = $2::date, due_date = $2::date + 30 WHERE id = $1', [bill, date]);
const manual = (date: string) => asService(pool, U.ab, co.A, () => createIntercompanyTransaction({
  groupId: co.G, sourceCompanyId: co.A, targetCompanyId: co.B, transactionType: 'sale', amount: 1000, transactionDate: date, description: `Manual sale ${date}` }));
const matchRows = (ids: string[]) => pool.query("UPDATE intercompany_transactions SET match_status = 'matched' WHERE id = ANY($1)", [ids]);
async function gen(start: string, end: string) {
  const skipped: SkippedEliminationRow[] = [];
  await asService(pool, U.ab, co.A, () => autoGenerateEliminations(co.G, start, end, [], skipped));
  return skipped;
}
async function mirror(date: string, billDate = date) {
  const m = await L.accepted({ date, lines: [['Item', 1, 1000]] });
  await redate(m.bill, billDate);
  await L.approveBill(m.bill);
  return m;
}

describe('M2: a row left to mirroring says when the mirror eliminates it', () => {
  it('the mirror\'s bill is dated 3 Apr, after the March period: the notice says "on 2026-04-03, after the period to 2026-03-31"', async () => {
    await turnOn('2026-03-01');
    const m = await mirror('2026-03-28', '2026-04-03');
    const r = await manual('2026-03-28'); await matchRows([r.id]);
    const skipped = await gen('2026-03-01', '2026-03-31');
    expect(skipped.map((s) => s.transactionId)).toEqual([r.id]);
    expect(skipped[0]!.detail).toBe('eliminated automatically on 2026-04-03, after the period to 2026-03-31, and is matched to this row');
    expect(skipped[0]!.mirroredRef).toContain('Invoice');
    expect(m.id).toBeTruthy();
  });

  it('the mirror eliminates in the period itself: no date is said beyond "eliminated automatically and is matched to this row"', async () => {
    await turnOn('2026-03-01');
    await mirror('2026-03-10');
    const r = await manual('2026-03-10'); await matchRows([r.id]);
    const skipped = await gen('2026-03-01', '2026-03-31');
    expect(skipped.map((s) => s.detail)).toEqual(['eliminated automatically and is matched to this row']);
  });
});

describe('L1: the derivation reads reference data as it is today (a stated limit)', () => {
  it('an UNBOUND row: changing the bill\'s supplier afterwards removes January\'s elimination from a January report (reversal chains are dated, this is not)', async () => {
    const m = await L.accepted({ date: '2026-01-15' });
    await L.approveBill(m.bill);
    await L.unbind();                                                     // (a row the sync never matched: judged on the document's current journal)
    expect(await L.derived('2026-01-01', '2026-01-31')).toHaveLength(1);
    await pool.query('UPDATE supplier_invoices SET supplier_id = $2 WHERE id = $1', [m.bill, L.extra.supplier]);
    expect(await L.derived('2026-01-01', '2026-01-31')).toHaveLength(0);   // (the supplier is no longer the connection's)
    await pool.query('UPDATE supplier_invoices SET supplier_id = (SELECT supplier_id FROM intercompany_connection_sides WHERE company_id = $2 AND connection_id = $3) WHERE id = $1',
      [m.bill, co.B, await conn()]);
    expect(await L.derived('2026-01-01', '2026-01-31')).toHaveLength(1);
  });
});

describe('L6: an accept that outlasts the sender\'s cancel hook (a stated limit)', () => {
  it('the receiver\'s accept read the ledger as live and holds the message > 2 s; the cancel commits, its withdraw hook gives up: a draft bill for a cancelled sale, the message unstamped', async () => {
    const sent = await sentInvoice(pool);
    const def = (await pool.query("SELECT pg_get_functiondef('public.intercompany_in_one_group(uuid,uuid)'::regprocedure) AS d")).rows[0].d as string;
    // (a slow accept: its membership re-check, after the ledger read and under the message row lock, takes 5 s)
    try {
      expect(def).toContain('AS $function$\nBEGIN\n');
      await pool.query(def.replace('AS $function$\nBEGIN\n', 'AS $function$\nBEGIN\n  PERFORM pg_catalog.pg_sleep(5);\n'));
      const accepting = inbox.accept(U.b, co.B, sent.id);
      await new Promise((r) => setTimeout(r, 800));                       // (the accept holds the message row and has read the ledger: live)
      await L.cancelSender(sent.inv.id);                                  // (the reversal commits; the withdraw hook waits 2 s on the message row and gives up)
      expect((await accepting).state.statusCode).toBe(200);
    } finally { await pool.query(def); }
    const msg = (await pool.query('SELECT status, source_cancelled_at, target_doc_id FROM intercompany_messages WHERE id = $1', [sent.id])).rows[0];
    expect(msg.status).toBe('accepted');
    expect(msg.source_cancelled_at).toBeNull();                           // (never stamped: the hook gave up)
    expect((await pool.query('SELECT status FROM supplier_invoices WHERE id = $1', [msg.target_doc_id])).rows[0].status).toBe('draft');
    expect((await pool.query('SELECT status FROM customer_invoices WHERE id = $1', [sent.inv.id])).rows[0].status).toBe('cancelled');
    // what the system still says: the ledger is the truth for the receiver, the group row eliminates nothing
    const out = await asAppUser(pool, U.b, co.B, async (q) => (await q.query('SELECT public.intercompany_message_source_out($1) AS o', [sent.id])).rows[0].o);
    expect(out).toBe(true);
    expect(await L.derived('2026-01-01', '2026-12-31')).toHaveLength(0);
  }, 60000);
});
