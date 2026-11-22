/**
 * Intercompany P2, round 26, M2: after the SENDER cancels, nothing invites an elimination of revenue that no longer exists.
 * A manual (P1) row R after the pair's cutover, linked to mirror M; M's bill approved in April (+E); the sender cancels M with a reversal dated
 * June (-E in June; the sender's revenue nets 0, the derived +E / -E net 0). A Jan-Jun run judges the link at 30 June, finds it no longer holds
 * and used to DRAFT R for Jan-Jun with "NOT eliminated automatically ... this may be the sale's only elimination": posting it took revenue out
 * twice. The facts now carry "the sender cancelled it" (intercompany_mirror_facts.sender_cancelled): the generator does not draft R (it reports
 * it), and every sentence says there is no revenue left to eliminate. A row BEFORE its pair's cutover is still drafted (it may be another sale).
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
const net = (adj: Awaited<ReturnType<typeof adjustments>>) => adj.filter((a) => a.automatic || a.status === 'posted')
  .reduce((n, a) => n + a.lines.reduce((x, l) => x + Number(l.debit) - Number(l.credit), 0), 0);

describe('M2: the sender cancelled the sale, so no elimination of its revenue is invited', () => {
  async function scenario() {
    await turnOn('2026-03-01');
    const m = await booked('2026-04-10');
    const r = await matched((await manual('2026-04-10')).id);
    // April: the row is left to mirroring (linked); then the sender cancels, the reversal dated 1 June
    expect((await gen('2026-04-01', '2026-04-30')).skipped.map((s) => s.transactionId)).toEqual([r]);
    await cancelInJune(m.inv.id);
    expect((await pool.query("SELECT entry_date::text AS d FROM gl_journal_entries WHERE reversal_of_id = $1 AND status = 'posted'", [m.message.source_journal_entry_id])).rows.map((x) => x.d)).toEqual(['2026-06-01']);
    return { m, r };
  }

  it('a Jan-Jun run does not draft R: it is reported as cancelled by the sender, nothing is stored, and the group figure carries no elimination of the cancelled sale', async () => {
    const { r } = await scenario();
    const g = await gen('2026-01-01', '2026-06-30');
    expect(g.drafted).toEqual([]);
    expect(g.flagged).toEqual([]);
    expect(g.skipped).toHaveLength(1);
    expect(g.skipped[0]).toMatchObject({ transactionId: r, senderCancelled: true });
    expect(g.skipped[0]!.detail).toMatch(/the sender cancelled it; there is no revenue left to eliminate/);
    expect(await stored()).toEqual([]);
    expect(net(await adjustments('2026-01-01', '2026-06-30')), 'derived +E and -E net to zero, no stored elimination').toBe(0);
  });

  it('a re-run says the same (nothing drafted, still reported)', async () => {
    const { r } = await scenario();
    await gen('2026-01-01', '2026-06-30');
    const again = await gen('2026-01-01', '2026-06-30');
    expect([again.drafted, again.skipped.map((s) => [s.transactionId, s.senderCancelled])]).toEqual([[], [[r, true]]]);
    expect(await stored()).toEqual([]);
  });

  it('a cancel reversed AFTER the period still leaves the period eliminated by the mirror (not reported as cancelled)', async () => {
    const { r } = await scenario();
    const g = await gen('2026-04-01', '2026-04-30');
    expect([g.drafted, g.skipped.map((s) => [s.transactionId, s.senderCancelled === true])]).toEqual([[], [[r, false]]]);
  });

  it('a stored draft of R made before (an older run) is worded from the same fact: the confirm says there is no revenue left to eliminate', async () => {
    const { r } = await scenario();
    await pool.query(
      `INSERT INTO consolidation_adjustments(group_id, adjustment_type, description, period_start, period_end, lines, source_intercompany_id)
       VALUES ($1, 'interco_revenue', 'older run', '2026-01-01', '2026-06-30', '[]'::jsonb, $2)`, [co.G, r]);
    const row = (await adjustments('2026-01-01', '2026-06-30')).find((a) => a.sourceIntercompanyId === r)!;
    expect(row.mirrorFacts?.mirrors[0]).toMatchObject({ stands: false, senderCancelled: true });
    const refused = await asService(pool, U.ab, co.A, () => postEliminationAdjustment(row.id, co.G, false)).then(() => 'posted', (e: Error) => e.message);
    expect(refused).toMatch(/the sender cancelled .*there is no revenue left to eliminate/);
    expect(refused).not.toMatch(/only elimination/);
  });

  it('BEFORE the pair\'s cutover the row is still drafted (it may be another sale), flagged with the cancelled wording and never "the only elimination"', async () => {
    await turnOn('2026-03-01', '2026-05-01 00:00+02');   // (the connection's cut-over is March, both sides mirror from May: the pair's cutover is May)
    const m = await booked('2026-04-10');
    const r = await matched((await manual('2026-04-10')).id);
    await cancelInJune(m.inv.id);
    const g = await gen('2026-01-01', '2026-06-30');
    expect([g.drafted, g.skipped]).toEqual([[r], []]);
    const note = g.flagged.find((f) => f.transactionId === r)!.reason;
    expect(note).toMatch(/the sender cancelled .*there is no revenue left to eliminate/);
    expect(note).not.toMatch(/only elimination/);
  });
});
