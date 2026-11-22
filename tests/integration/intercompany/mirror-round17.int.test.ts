/**
 * Intercompany P2, round 17: the round-16 breaker's probes as asserting tests.
 *  H1  a sender cancel whose reversal is dated AFTER the period (VAT-locked, rolled to May) leaves the period eliminated by the mirror: a re-run
 *      keeps the link, a first run makes it; the period is eliminated once. A cancel reversed inside the period drafts the row, and the draft
 *      is still flagged (the cancelled mirror is judged for the period, so the confirm says it is NOT eliminated);
 *  M1  two equal sales, two mirrors: each row takes its own free mirror; a pre-cutover row never starves a post-cutover one ('closer');
 *  L1  a direct call cannot link a row before its pair's cutover;
 *  L2  a draft posted before the receiver approved: once the mirror stands the posted row is warned on the list (reverse this one).
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
async function turnOn(cutover = '2026-03-01') {
  const id = await conn();
  await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connection_sides SET supplier_id = $2 WHERE connection_id = $1 AND company_id = $3', [id, party.aSupplier, co.A]), true);
  await asAppUser(pool, U.ab, co.B, (q) => q.query('UPDATE intercompany_connection_sides SET customer_id = $2 WHERE connection_id = $1 AND company_id = $3', [id, party.bCustomer, co.B]), true);
  await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connections SET cutover_date = $2 WHERE id = $1', [id, cutover]), true);
  await withoutTrigger(pool, 'intercompany_connection_sides', 'trg_intercompany_sides_auto_since', async (q) => {
    await q.query('ALTER TABLE intercompany_connection_sides DISABLE TRIGGER trg_intercompany_sides_guard');
    await q.query("UPDATE intercompany_connection_sides SET mirroring_since = '2026-01-01 00:00+02' WHERE connection_id = $1", [id]);
    await q.query('ALTER TABLE intercompany_connection_sides ENABLE ALWAYS TRIGGER trg_intercompany_sides_guard');
  });
}
const redate = (bill: string, date: string) => pool.query('UPDATE supplier_invoices SET invoice_date = $2::date, due_date = $2::date + 30 WHERE id = $1', [bill, date]);
const manual = (src: string, tgt: string, type: string, date: string) => asService(pool, U.ab, src, () => createIntercompanyTransaction({
  groupId: co.G, sourceCompanyId: src, targetCompanyId: tgt, transactionType: type, amount: 1000, transactionDate: date, description: `Manual ${type} ${date}` }));
const matchRows = (ids: string[]) => pool.query("UPDATE intercompany_transactions SET match_status = 'matched' WHERE id = ANY($1)", [ids]);
async function gen(start: string, end: string) {
  const flagged: FlaggedEliminationRow[] = []; const skipped: SkippedEliminationRow[] = [];
  const made = await asService(pool, U.ab, co.A, () => autoGenerateEliminations(co.G, start, end, flagged, skipped));
  return { drafted: made.map((m) => m.sourceIntercompanyId), skipped: skipped.map((s) => s.transactionId), flagged };
}
async function booked(date: string) { const m = await L.accepted({ date }); await redate(m.bill, date); await L.approveBill(m.bill); return m; }
async function reverseBillOn(bill: string, date: string) {
  const je = (await pool.query('SELECT gl_journal_entry_id AS je FROM supplier_invoices WHERE id = $1', [bill])).rows[0].je as string;
  const rev = (await pool.query(`INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id)
    SELECT $2::date, 'reversal', source, 'draft', created_by, company_id FROM gl_journal_entries WHERE id = $1 RETURNING id`, [je, date])).rows[0].id as string;
  await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description)
    SELECT $2, gl_account_id, credit, debit, company_id, 'reversal' FROM gl_journal_lines WHERE journal_entry_id = $1`, [je, rev]);
  await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now(), reversal_of_id = $2 WHERE id = $1", [rev, je]);
}
const activeLinks = async () => (await pool.query('SELECT row_id FROM intercompany_mirror_links WHERE group_id = $1 AND released_at IS NULL', [co.G])).rows.map((r) => r.row_id as string);
const total = async (s: string, e: string) => {
  const rows = await asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, s, e));
  const pick = (a: { automatic?: boolean; status: string }) => a.automatic || a.status === 'posted';
  const out = rows.filter(pick).map((a) => `${a.automatic ? 'AUTO' : 'STORED'} ${a.periodStart}..${a.periodEnd} dr=${a.lines.reduce((x, l) => x + Number(l.debit), 0)}`);
  return { lines: out, sum: rows.filter(pick).reduce((x, a) => x + a.lines.reduce((y, l) => y + Number(l.debit), 0), 0) };
};
const adjOf = async (row: string) => (await pool.query('SELECT id, status, description FROM consolidation_adjustments WHERE source_intercompany_id = $1', [row])).rows[0];
const post = (id: string, confirm = false) => asService(pool, U.ab, co.A, () => postEliminationAdjustment(id, co.G, confirm)).then(() => 'posted', (e: Error) => `REFUSED: ${e.message}`);

const lockVat = () => pool.query("INSERT INTO vat_period_locks(company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by, actor_type) VALUES ($1, '2026-03-01', '2026-04-30', 0, 0, 0, now(), $2, 'human')", [co.A, U.a]);
const unlockVat = () => pool.query('DELETE FROM vat_period_locks WHERE company_id = $1', [co.A]);
const cancelLocked = async (inv: string) => { await lockVat(); try { await L.cancelSender(inv); } finally { await unlockVat(); } };

describe('H1: a cancel reversed after the period leaves the period eliminated by the mirror', () => {
  it('a re-run of March after a VAT-locked cancel (reversal rolled to May) keeps the link: March is eliminated once', async () => {
    await turnOn();
    const m = await booked('2026-03-15');
    const s = await manual(co.A, co.B, 'sale', '2026-03-15'); await matchRows([s.id]);
    expect((await gen('2026-03-01', '2026-03-31')).skipped).toEqual([s.id]);
    await cancelLocked(m.inv.id);
    expect((await pool.query("SELECT entry_date::text AS d FROM gl_journal_entries WHERE reversal_of_id = $1 AND status = 'posted'", [m.message.source_journal_entry_id])).rows.map((r) => r.d)).toEqual(['2026-05-01']);
    const again = await gen('2026-03-01', '2026-03-31');
    expect([again.skipped, again.drafted]).toEqual([[s.id], []]);
    expect((await total('2026-03-01', '2026-03-31')).sum).toBe(1000);
  });

  it('a FIRST run of March after that cancel links the row: March is eliminated once', async () => {
    await turnOn();
    const m = await booked('2026-03-15');
    const s = await manual(co.A, co.B, 'sale', '2026-03-15'); await matchRows([s.id]);
    await cancelLocked(m.inv.id);
    const g = await gen('2026-03-01', '2026-03-31');
    expect([g.skipped, g.drafted]).toEqual([[s.id], []]);
    expect((await total('2026-03-01', '2026-03-31')).sum).toBe(1000);
  });

  it('a cancel reversed INSIDE March: the row is NOT drafted (round 26, M2: the sender cancelled the sale, no revenue is left to eliminate); it is reported as cancelled and nothing is stored', async () => {
    await turnOn();
    const m = await booked('2026-03-15');
    const s = await manual(co.A, co.B, 'sale', '2026-03-15'); await matchRows([s.id]);
    await L.cancelSender(m.inv.id);
    // the cancel's reversal is dated on the invoice's own date (an open period), so inside March whatever today is
    expect((await pool.query("SELECT entry_date::text AS d FROM gl_journal_entries WHERE reversal_of_id = $1 AND status = 'posted'", [m.message.source_journal_entry_id])).rows.map((r) => r.d)).toEqual(['2026-03-15']);
    const end = '2026-03-31';
    const g = await gen('2026-03-01', end);
    expect([g.skipped, g.drafted.includes(s.id), g.flagged]).toEqual([[s.id], false, []]);
    expect(await adjOf(s.id)).toBeUndefined();
    expect(await activeLinks()).toEqual([]);   // (the link was released: the mirror no longer eliminates the row)
  });
});

describe('M1: an assignment, not a single guess', () => {
  it('two equal invoices and two manual sales on one day: each row takes its own mirror (March eliminated twice, for two sales)', async () => {
    await turnOn();
    await booked('2026-03-15'); await booked('2026-03-15');
    const s1 = await manual(co.A, co.B, 'sale', '2026-03-15'); const s2 = await manual(co.A, co.B, 'sale', '2026-03-15');
    await matchRows([s1.id, s2.id]);
    const g = await gen('2026-03-01', '2026-03-31');
    expect([g.skipped.sort(), g.drafted]).toEqual([[s1.id, s2.id].sort(), []]);
    expect((await total('2026-03-01', '2026-03-31')).sum).toBe(2000);
  });

  it('a nearer PRE-cutover row does not starve the post-cutover row: the 6 March row takes the 2 March mirror', async () => {
    await turnOn('2026-03-01');
    await booked('2026-03-02');
    const c = await manual(co.A, co.B, 'sale', '2026-02-28'); const r = await manual(co.A, co.B, 'sale', '2026-03-06');
    await matchRows([c.id, r.id]);
    expect((await gen('2026-03-01', '2026-03-31')).skipped).toEqual([r.id]);
  });
});

describe('L1: a direct call', () => {
  it('cannot link a row dated before its pair\'s cutover (and the real row then takes the mirror)', async () => {
    await turnOn('2026-03-01');
    await booked('2026-03-02');
    const pre = await manual(co.A, co.B, 'sale', '2026-02-27'); const r = await manual(co.A, co.B, 'sale', '2026-03-02');
    await matchRows([pre.id, r.id]);
    const call = (row: string, d: string) => asAppUser(pool, U.ab, co.A, async (q) => (await q.query('SELECT * FROM public.intercompany_mirror_link($1, $2)', [row, d])).rows[0], true);
    expect((await call(pre.id, '2026-03-31')).state).toBe('none');
    expect(await activeLinks()).toEqual([]);
    expect((await gen('2026-03-01', '2026-03-31')).skipped).toEqual([r.id]);
  });
});

describe('L2: posted before the receiver approved', () => {
  it('once the bill is approved in the period, the posted row is warned on the list: the mirror is eliminated automatically, reverse this one', async () => {
    await turnOn();
    const m = await L.accepted({ date: '2026-03-15' }); await redate(m.bill, '2026-03-20');
    const s = await manual(co.A, co.B, 'sale', '2026-03-15'); await matchRows([s.id]);
    const g = await gen('2026-03-01', '2026-03-31');
    expect(g.drafted).toContain(s.id);
    const a = await adjOf(s.id);
    expect(await post(a.id, true)).toBe('posted');
    await L.approveBill(m.bill);
    const row = (await asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, '2026-03-01', '2026-03-31'))).find((x) => x.id === a.id)!;
    expect([row.status, row.mirroredDuplicateOf ? 'warned' : 'none', row.mirrorStands]).toEqual(['posted', 'warned', true]);
  });
});
