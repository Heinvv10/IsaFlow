/**
 * Intercompany P2, round 20: the round-19 breaker's findings as asserting tests (every wording still comes from the row's mirror facts).
 *  M1  a month-sum member the sender cancelled counts while the period carries it (a cancel rolled past a closed fiscal period is dated later);
 *  M2  a credit note in a month sum (its group row is negative): never "R1 000 of R800 ... in full", never "eliminated" then "None of them";
 *  M3  the ruled later-date rule is kept (a 28 Mar row whose mirror's bill is dated 3 Apr is eliminated in April) and said: "on 2026-04-03,
 *      after the period";
 *  L1  a stored note says when it was true ("as found by the run of"), and a released link is worded in the past;
 *  L2  a mirror the OTHER role's row linked is "matched to a purchase row", never "not matched to any row yet";
 *  L3  a row outside the match window: the note says which window was compared (a stated limit), never "no mirrored document matches";
 *  L4  a sum matched by totals with VAT says so, and that mirroring eliminates them net of VAT.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { createIntercompanyTransaction } from '../../../src/modules/accounting/services/reports/intercompanyService';
import { autoGenerateEliminations, type FlaggedEliminationRow, type SkippedEliminationRow } from '../../../src/modules/accounting/services/reports/eliminationGenerator';
import { getEliminationAdjustments, postEliminationAdjustment } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { mirrorApprovedCreditNote } from '../../../src/modules/accounting/services/intercompany/outboxService';
import { NO_MIRROR_MATCH } from '../../../src/modules/accounting/services/reports/mirrorFacts';
import { formatMoney as R } from '../../../src/lib/money/formatMoney';
import { approveCreditNoteRow, asService, co, inbox, plantArCreditNote, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';
import { asAppUser, party, withoutTrigger } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
beforeAll(async () => { await L.setup(); await L.monthly(co.A, 2026); await L.monthly(co.B, 2026); }, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const conn = async () => (await pool.query("SELECT id FROM intercompany_connections WHERE status <> 'revoked' AND $1 IN (company_low_id, company_high_id) AND $2 IN (company_low_id, company_high_id)", [co.A, co.B])).rows[0].id as string;
/** The pair's cutover is the later of `cutover` and `since`. */
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
const manual = (date: string, amount = 1000, type = 'sale') => asService(pool, U.ab, type === 'purchase' ? co.B : co.A, () => createIntercompanyTransaction({
  groupId: co.G, sourceCompanyId: type === 'purchase' ? co.B : co.A, targetCompanyId: type === 'purchase' ? co.A : co.B, transactionType: type, amount,
  transactionDate: date, description: `Manual ${type} ${date}` }));
const matchRows = (ids: string[]) => pool.query("UPDATE intercompany_transactions SET match_status = 'matched' WHERE id = ANY($1)", [ids]);
async function gen(start: string, end: string) {
  const flagged: FlaggedEliminationRow[] = []; const skipped: SkippedEliminationRow[] = [];
  const made = await asService(pool, U.ab, co.A, () => autoGenerateEliminations(co.G, start, end, flagged, skipped));
  return { drafted: made.map((m) => m.sourceIntercompanyId), skipped: skipped.map((s) => s.transactionId), flagged };
}
/** A mirror of `price` (one line: its subtotal; 15% VAT) whose sender is dated `date` and bill `billDate`; approved unless `approve` is false. */
async function mirror(date: string, price: number, approve = true, billDate = date) {
  const m = await L.accepted({ date, lines: [['Item', 1, price]] });
  await redate(m.bill, billDate);
  if (approve) await L.approveBill(m.bill);
  const desc = (await pool.query('SELECT description FROM intercompany_transactions WHERE id = $1', [m.message.group_transaction_id])).rows[0].description as string;
  return { ...m, desc };
}
const listed = async (row: string, s: string, e: string) => (await asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, s, e))).find((a) => a.sourceIntercompanyId === row)!;
const post = (id: string, confirm = false) => asService(pool, U.ab, co.A, () => postEliminationAdjustment(id, co.G, confirm)).then(() => 'posted', (e: Error) => `REFUSED: ${e.message}`);
const total = async (s: string, e: string) => {
  const rows = await asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, s, e));
  return rows.filter((a) => a.automatic || a.status === 'posted').reduce((x, a) => x + a.lines.reduce((y, l) => y + Number(l.debit), 0), 0);
};
const jhbToday = async () => (await pool.query("SELECT (now() AT TIME ZONE 'Africa/Johannesburg')::date::text AS d")).rows[0].d as string;
const reasonOf = (g: Awaited<ReturnType<typeof gen>>, row: string) => g.flagged.find((f) => f.transactionId === row)?.reason;

describe('M1: a cancelled month-sum member counts while the period carries it', () => {
  it('a cancel rolled past a CLOSED January (dated today): the January row is flagged and refused, never posted silently twice', async () => {
    const a = await mirror('2026-01-10', 600);
    const b = await mirror('2026-01-12', 400);
    await pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1 AND start_date = '2026-01-01'", [co.A]);
    try { await L.cancelSender(b.inv.id); } finally {
      await pool.query("UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1 AND start_date = '2026-01-01'", [co.A]);
    }
    const rev = (await pool.query("SELECT entry_date::text AS d FROM gl_journal_entries WHERE reversal_of_id = $1 AND status = 'posted'", [b.message.source_journal_entry_id])).rows;
    expect(rev.length).toBe(1);
    expect(rev[0].d > '2026-01-31').toBe(true);                       // (the roll: January still carries the document)
    const s = await manual('2026-01-20'); await matchRows([s.id]);
    const g = await gen('2026-01-01', '2026-01-31');
    const sentence = `Possibly the same sale as 2 mirrored documents of January 2026: ${a.desc} (${R(600)}: eliminated automatically, not matched to any row yet) and `
      + `${b.desc} (${R(400)}: eliminated automatically, not matched to any row yet). All of them are eliminated automatically by mirroring: `
      + 'if it is the same sale, posting this would eliminate it twice.';
    expect(reasonOf(g, s.id)).toBe(sentence);
    const row = await listed(s.id, '2026-01-01', '2026-01-31');
    expect(await post(row.id)).toBe(`REFUSED: ${sentence} Confirm to post it.`);
    expect(await total('2026-01-01', '2026-01-31')).toBe(1000);
  });
});

describe('M2: a credit note in a month sum', () => {
  it('an invoice that stands and a credit note that does not (never approved): "only some of them", never "R1 000 of R800 ... in full"', async () => {
    const inv = await mirror('2026-03-05', 1000);
    const cn = await plantArCreditNote(pool, { date: '2026-03-06' });   // (R200 + R30 VAT)
    await approveCreditNoteRow(pool, cn);
    await asService(pool, U.a, co.A, () => mirrorApprovedCreditNote(co.A, cn));
    const msg = (await pool.query('SELECT id, group_transaction_id FROM intercompany_messages WHERE source_doc_id = $1', [cn])).rows[0];
    expect((await inbox.accept(U.b, co.B, msg.id)).state.statusCode).toBe(200);   // (a draft supplier credit note: it does not stand)
    const cnRow = (await pool.query('SELECT amount::float AS a, description FROM intercompany_transactions WHERE id = $1', [msg.group_transaction_id])).rows[0];
    expect(cnRow.a).toBe(-200);                                        // (a credit note's group row is NEGATIVE: minus its subtotal)
    const s = await manual('2026-03-10', 800); await matchRows([s.id]);
    const g = await gen('2026-03-01', '2026-03-31');
    expect(reasonOf(g, s.id)).toBe(`Possibly the same sale as 2 mirrored documents of March 2026: ${inv.desc} (${R(1000)}: eliminated automatically, not matched to any row yet) and `
      + `${cnRow.description} (${R(-200)}: NOT eliminated automatically for the period to 2026-03-31). Only some of them are eliminated automatically by mirroring: `
      + 'if it is the same sale, posting this in full would eliminate that part twice.');
  });
});

describe('M3: the later document date decides the month (the ruled rule, now said)', () => {
  it('after the cutover: a 28 Mar row whose mirror\'s bill is dated 3 Apr is left to mirroring in March and eliminated in April', async () => {
    await turnOn('2026-03-01');
    await mirror('2026-03-28', 1000, true, '2026-04-03');
    const r = await manual('2026-03-28'); await matchRows([r.id]);
    expect((await gen('2026-03-01', '2026-03-31')).skipped).toEqual([r.id]);
    expect([await total('2026-03-01', '2026-03-31'), await total('2026-04-01', '2026-04-30')]).toEqual([0, 1000]);
  });

  it('before the cutover: the flag says the mirror is eliminated on 2026-04-03, after the period to 2026-03-31', async () => {
    await turnOn('2026-03-01', '2026-03-30');                         // (the cutover is 30 March: a 28 March row is before it)
    const m = await mirror('2026-03-28', 1000, true, '2026-04-03');
    const r = await manual('2026-03-28'); await matchRows([r.id]);
    expect(reasonOf(await gen('2026-03-01', '2026-03-31'), r.id)).toBe(`Possibly the same sale as mirrored document ${m.desc}, which is eliminated automatically `
      + 'on 2026-04-03, after the period to 2026-03-31, and is not matched to any row yet. If it is the same sale, posting this would eliminate it twice.');
  });
});

describe('L1: a stored note says when it was true', () => {
  it('a released link: the draft\'s note is dated by the run and worded in the past', async () => {
    await turnOn('2026-03-01');
    const m = await mirror('2026-03-15', 1000);
    const s = await manual('2026-03-15'); await matchRows([s.id]);
    expect((await gen('2026-03-01', '2026-03-31')).skipped).toEqual([s.id]);
    await L.cancelSender(m.inv.id);
    const again = await gen('2026-03-01', '2026-03-31');
    expect(again.drafted).toEqual([s.id]);
    const row = await listed(s.id, '2026-03-01', '2026-03-31');
    expect(row.description).toContain(`CHECK BEFORE POSTING (as found by the run of ${await jhbToday()}): The pair mirrors from 2026-03-01. Its link to mirrored document ${m.desc} `
      + 'was released: that mirror did not eliminate this row for the period to 2026-03-31 when this run was made.');
  });
});

describe('L2: a mirror the other role\'s row linked', () => {
  it('a sale row\'s flag says the mirror is matched to a purchase row, never "not matched to any row yet"', async () => {
    await turnOn('2026-03-01', '2026-03-15');
    const m = await mirror('2026-03-15', 1000);
    const s = await manual('2026-03-10'); const p = await manual('2026-03-15', 1000, 'purchase'); await matchRows([s.id, p.id]);
    const g = await gen('2026-03-01', '2026-03-31');
    expect([g.skipped, g.drafted]).toEqual([[p.id], [s.id]]);
    expect(reasonOf(g, s.id)).toBe(`Possibly the same sale as mirrored document ${m.desc}, which is eliminated automatically and is matched to a purchase row `
      + '(the other side of a sale), not to any sale row yet. If it is the same sale, posting this would eliminate it twice.');
  });
});

describe('L3: a row outside the match window (a stated limit)', () => {
  it('a 25 Mar row and an invoice of 3 Apr (9 days, another month): the note names the window compared, and it posts without a confirm', async () => {
    await turnOn('2026-03-01');
    await mirror('2026-04-03', 1000);
    const r = await manual('2026-03-25'); await matchRows([r.id]);
    const g = await gen('2026-03-01', '2026-03-31');
    expect(reasonOf(g, r.id)).toBe(`The pair mirrors from 2026-03-01. ${NO_MIRROR_MATCH}`);
    expect(await post((await listed(r.id, '2026-03-01', '2026-03-31')).id)).toBe('posted');
  });
});

describe('L4: a month sum matched by totals with VAT', () => {
  it('names the amounts with VAT and says mirroring eliminates them net of VAT, never "R1 150 of R1 150"', async () => {
    const a = await mirror('2026-03-05', 600);   // (R690 with VAT)
    const b = await mirror('2026-03-06', 400);   // (R460 with VAT)
    const s = await manual('2026-03-10', 1150); await matchRows([s.id]);
    const g = await gen('2026-03-01', '2026-03-31');
    expect(reasonOf(g, s.id)).toBe(`Possibly the same sale as 2 mirrored documents of March 2026: ${a.desc} (${R(690)} with VAT: eliminated automatically, not matched to any row yet) and `
      + `${b.desc} (${R(460)} with VAT: eliminated automatically, not matched to any row yet). All of them are eliminated automatically by mirroring, net of their VAT: `
      + 'if it is the same sale, posting this would eliminate it twice.');
  });
});
