/**
 * Intercompany P2, round 27 (blind review of 5f202605c9), H1 + M1 + L3 + L4: the RULING 2026-11-21 holds after the sender cancels. A manual (P1) row
 * is left to mirroring ONLY through the stored, exclusive link; with none it is DRAFTED and flagged CHECK BEFORE POSTING. Round 26 skipped any row
 * whose closest free candidate was a cancelled mirror, which stranded a genuine row whose own revenue stands: it is drafted again. What stays of
 * round 26 is the WORDING: a single mirror whose sent-with journal is reversed as at the date (intercompany_mirror_facts.sender_cancelled) is
 * described conditionally ("if it is the same sale there is no revenue left to eliminate: do not post this; if another sale, it still needs this").
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { createIntercompanyTransaction } from '../../../src/modules/accounting/services/reports/intercompanyService';
import { autoGenerateEliminations, type FlaggedEliminationRow, type SkippedEliminationRow } from '../../../src/modules/accounting/services/reports/eliminationGenerator';
import { getEliminationAdjustments, postEliminationAdjustment } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { asService, co, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';
import { asAppUser, party, withoutTrigger } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
beforeAll(async () => { await L.setup(); await L.monthly(co.A, 2026); await L.monthly(co.B, 2026); }, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const conn = async () => (await pool.query("SELECT id FROM intercompany_connections WHERE status <> 'revoked' AND $1 IN (company_low_id, company_high_id) AND $2 IN (company_low_id, company_high_id)", [co.A, co.B])).rows[0].id as string;
async function turnOn(cutover: string, since = '2026-01-01 00:00+02') {
  const id = await conn();
  await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connection_sides SET supplier_id = $2 WHERE connection_id = $1 AND company_id = $3', [id, party.aSupplier, co.A]), true);
  await asAppUser(pool, U.ab, co.B, (q) => q.query('UPDATE intercompany_connection_sides SET customer_id = $2 WHERE connection_id = $1 AND company_id = $3', [id, party.bCustomer, co.B]), true);
  await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connections SET cutover_date = $2 WHERE id = $1', [id, cutover]), true);
  await withoutTrigger(pool, 'intercompany_connection_sides', 'trg_intercompany_sides_auto_since', async (q) => {
    await q.query('ALTER TABLE intercompany_connection_sides DISABLE TRIGGER trg_intercompany_sides_guard');
    await q.query("UPDATE intercompany_connection_sides SET mirroring_since = $2 WHERE connection_id = $1", [id, since]);
    await q.query('ALTER TABLE intercompany_connection_sides ENABLE ALWAYS TRIGGER trg_intercompany_sides_guard');
  });
}
const redate = (bill: string, date: string) => pool.query('UPDATE supplier_invoices SET invoice_date = $2::date, due_date = $2::date + 30 WHERE id = $1', [bill, date]);
const manual = (date: string) => asService(pool, U.ab, co.A, () => createIntercompanyTransaction({
  groupId: co.G, sourceCompanyId: co.A, targetCompanyId: co.B, transactionType: 'sale', amount: 1000, transactionDate: date, description: `Manual sale ${date}` }));
const matched = async (id: string) => { await pool.query("UPDATE intercompany_transactions SET match_status = 'matched' WHERE id = $1", [id]); return id; };
async function gen(start: string, end: string) {
  const flagged: FlaggedEliminationRow[] = []; const skipped: SkippedEliminationRow[] = [];
  const made = await asService(pool, U.ab, co.A, () => autoGenerateEliminations(co.G, start, end, flagged, skipped));
  return { drafted: made.map((m) => m.sourceIntercompanyId), skipped, flagged };
}
async function booked(date: string) { const m = await L.accepted({ date }); await redate(m.bill, date); await L.approveBill(m.bill); return m; }
/** The sender's cancel with its reversal ROLLED to 1 June (a VAT-locked April-May). */
async function cancelInJune(inv: string) {
  await pool.query("INSERT INTO vat_period_locks(company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by, actor_type) VALUES ($1, '2026-04-01', '2026-05-31', 0, 0, 0, now(), $2, 'human')", [co.A, U.a]);
  try { await L.cancelSender(inv); } finally { await pool.query('DELETE FROM vat_period_locks WHERE company_id = $1', [co.A]); }
}
const adjustments = async (s: string, e: string) => asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, s, e));
const stored = async () => (await pool.query('SELECT id, status, description FROM consolidation_adjustments WHERE group_id = $1', [co.G])).rows;
const CANCELLED = (ref: string, end: string, cut = '') => `Possibly the same sale as mirrored document ${ref}, which the sender cancelled (its journal is reversed as at ${end})${cut}. `
  + 'If it is the same sale there is no revenue left to eliminate: do not post this (a posted elimination would be an over-elimination to reverse). '
  + 'If it is another sale, it still needs this elimination.';
const refOf = async (m: { message: { group_transaction_id: string } }) =>
  (await pool.query('SELECT description FROM intercompany_transactions WHERE id = $1', [m.message.group_transaction_id])).rows[0].description as string;
const reversalOf = async (je: string) => (await pool.query("SELECT id, entry_date::text AS d FROM gl_journal_entries WHERE reversal_of_id = $1 AND status = 'posted'", [je])).rows[0] as { id: string; d: string };
/** The sender revives the cancelled sale: its reversal journal is reversed on `date` (the chain's third journal). */
async function reviveOn(je: string, date: string) {
  const rev = (await pool.query(`INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id)
    SELECT $2::date, 'reversal', source, 'draft', created_by, company_id FROM gl_journal_entries WHERE id = $1 RETURNING id`, [je, date])).rows[0].id as string;
  await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description)
    SELECT $2, gl_account_id, credit, debit, company_id, 'reversal' FROM gl_journal_lines WHERE journal_entry_id = $1`, [je, rev]);
  await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now(), reversal_of_id = $2 WHERE id = $1", [rev, je]);
}

describe('H1: a post-cutover row with no stored link is DRAFTED and flagged, whatever the closest free candidate is', () => {
  it('a genuine row R (10 Apr) and a separate mirrored invoice M (12 Apr, same amount) the sender cancelled: the April run drafts R, flagged CHECK BEFORE POSTING with the conditional wording; nothing is skipped', async () => {
    await turnOn('2026-03-01');
    const m = await booked('2026-04-12');
    await L.cancelSender(m.inv.id);
    expect((await reversalOf(m.message.source_journal_entry_id)).d, 'the cancel is dated inside April').toMatch(/^2026-04-/);
    const r = await matched((await manual('2026-04-10')).id);
    const ref = await refOf(m);
    const g = await gen('2026-04-01', '2026-04-30');
    expect([g.drafted, g.skipped]).toEqual([[r], []]);
    expect(g.flagged.map((f) => [f.transactionId, f.mirroredRef])).toEqual([[r, ref]]);
    expect(g.flagged[0]!.reason).toBe(`The pair mirrors from 2026-03-01. ${CANCELLED(ref, '2026-04-30')}`);
    const [row] = await stored();
    expect(row.status).toBe('draft');
    expect(row.description).toMatch(/CHECK BEFORE POSTING \(as found by the run of \d{4}-\d{2}-\d{2}\): The pair mirrors from 2026-03-01\. Possibly the same sale as mirrored document .*which the sender cancelled/);
    expect(await adjustments('2026-04-01', '2026-04-30').then((a) => a.filter((x) => x.sourceIntercompanyId === r).length), 'R is on the list for the period').toBe(1);
  });

  it('a cancel dated INSIDE the period and revived (re-reversed) AFTER it: the period\'s run drafts R, it is not stranded', async () => {
    await turnOn('2026-03-01');
    const m = await booked('2026-04-12');
    await L.cancelSender(m.inv.id);
    await reviveOn((await reversalOf(m.message.source_journal_entry_id)).id, '2026-05-05');
    const r = await matched((await manual('2026-04-10')).id);
    const g = await gen('2026-04-01', '2026-04-30');
    expect([g.drafted, g.skipped]).toEqual([[r], []]);
    expect(g.flagged.map((f) => f.transactionId)).toEqual([r]);
    expect((await stored()).map((x) => x.status)).toEqual(['draft']);
  });

  it('a row after a cancel dated after the period is still left to mirroring, as before (the link holds as at the period)', async () => {
    await turnOn('2026-03-01');
    const m = await booked('2026-04-10');
    const r = await matched((await manual('2026-04-10')).id);
    expect((await gen('2026-04-01', '2026-04-30')).skipped.map((s) => s.transactionId)).toEqual([r]);
    await cancelInJune(m.inv.id);
    const g = await gen('2026-04-01', '2026-04-30');
    expect([g.drafted, g.skipped.map((s) => s.transactionId)]).toEqual([[], [r]]);
  });

  it('Jan-Jun after the sender cancelled in June: R, linked in April, is drafted for the half-year and flagged', async () => {
    await turnOn('2026-03-01');
    const m = await booked('2026-04-10');
    const r = await matched((await manual('2026-04-10')).id);
    await gen('2026-04-01', '2026-04-30');
    await cancelInJune(m.inv.id);
    const g = await gen('2026-01-01', '2026-06-30');
    expect([g.drafted, g.skipped]).toEqual([[r], []]);
    expect(g.flagged[0]!.reason).toContain(CANCELLED(await refOf(m), '2026-06-30'));
  });
});

describe('M1: the wording of a draft / a stored draft / a posted row comes from the one fact', () => {
  async function stale() {
    await turnOn('2026-03-01');
    const m = await booked('2026-04-10');
    const r = await matched((await manual('2026-04-10')).id);
    await gen('2026-04-01', '2026-04-30');
    await cancelInJune(m.inv.id);
    await pool.query(
      `INSERT INTO consolidation_adjustments(group_id, adjustment_type, description, period_start, period_end, lines, source_intercompany_id)
       VALUES ($1, 'interco_revenue', 'older run', '2026-01-01', '2026-06-30', '[]'::jsonb, $2)`, [co.G, r]);
    return { m, row: (await adjustments('2026-01-01', '2026-06-30')).find((a) => a.sourceIntercompanyId === r)! };
  }

  it('the confirm of a stored draft says: possibly the same sale, no revenue left if it is, do not post; if another sale it still needs this', async () => {
    const { m, row } = await stale();
    expect(row.mirrorFacts?.mirrors[0]).toMatchObject({ stands: false, senderCancelled: true });
    const refused = await asService(pool, U.ab, co.A, () => postEliminationAdjustment(row.id, co.G, false)).then(() => 'posted', (e: Error) => e.message);
    expect(refused).toContain(CANCELLED(await refOf(m), '2026-06-30', ' (the pair mirrors from 2026-03-01)'));
    expect(refused).not.toMatch(/only elimination|NOT eliminated/);
  });
});
