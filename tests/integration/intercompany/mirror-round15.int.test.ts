/**
 * Intercompany P2, round 15: the per-pair cutover skips a row ONLY when a mirror of this group that matches it stands now (R14-H1), a pair has a
 * cutover only in the group its mirrors go to (R14-H2), a side switched on mirrors from the next Johannesburg day, and a budget-stopped
 * auto-accept run gives the unstarted messages their attempt back (R14 quality M2).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { createIntercompanyTransaction, matchIntercompanyTransactions } from '../../../src/modules/accounting/services/reports/intercompanyService';
import { autoGenerateEliminations, type FlaggedEliminationRow, type SkippedEliminationRow } from '../../../src/modules/accounting/services/reports/eliminationGenerator';
import { getPairCutovers } from '../../../src/modules/accounting/services/reports/eliminationDuplicates';
import { getEliminationAdjustments, postEliminationAdjustment } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { asService, co, inbox, sentInvoice, U } from './mirror.helpers';
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
async function matchedPair(date = '2026-03-15') {
  const s = await manual(co.A, co.B, 'sale', date);
  const p = await manual(co.B, co.A, 'purchase', date);
  await asService(pool, U.ab, co.A, () => matchIntercompanyTransactions(s.id, p.id, co.G, U.ab));
  return [s.id as string, p.id as string];
}
async function gen(group = co.G) {
  const flagged: FlaggedEliminationRow[] = []; const skipped: SkippedEliminationRow[] = [];
  const made = await asService(pool, U.ab, co.A, () => autoGenerateEliminations(group, '2026-03-01', '2026-03-31', flagged, skipped));
  return { drafted: made.map((m) => m.sourceIntercompanyId), flagged, skipped: skipped.map((s) => s.transactionId), skippedRows: skipped };
}
const billOf = async (msg: string) => (await pool.query('SELECT target_doc_id FROM intercompany_messages WHERE id = $1', [msg])).rows[0].target_doc_id as string;

describe('R14-H1: after the cutover a row is skipped only when a standing mirror of this group accounts for it', () => {
  it('control: the mirror accepted and approved: the pair\'s sale and purchase are both skipped, named by description, date and amount', async () => {
    await turnOn();
    const m = await L.accepted({ date: '2026-03-15' }); await redate(m.bill, '2026-03-15'); await L.approveBill(m.bill);
    const [s, p] = await matchedPair();
    const g = await gen();
    expect(g.skipped.sort()).toEqual([s, p].sort());
    expect(g.skippedRows[0]).toMatchObject({ date: '2026-03-15', amount: 1000, description: expect.stringMatching(/^Manual /), reason: expect.stringMatching(/^eliminated by mirroring \(/) });
  });

  it.each([
    ['rejected by the receiver', async (msg: string) => { expect((await inbox.reject(U.b, co.B, msg, { reason: 'keyed by hand' })).state.statusCode).toBe(200); }],
    ['still pending', async () => undefined],
    ['accepted but the bill never approved', async (msg: string) => { expect((await inbox.accept(U.b, co.B, msg)).state.statusCode).toBe(200); }],
  ] as const)('the mirror %s: drafted and flagged (round 16 wording: why no mirrored document eliminates it)', async (_n, act) => {
    await turnOn();
    const sent = await sentInvoice(pool, { date: '2026-03-15' });
    await act(sent.id);
    const [s] = await matchedPair();
    const g = await gen();
    expect(g.skipped).toEqual([]);
    expect(g.drafted).toContain(s);
    expect(g.flagged.find((f) => f.transactionId === s)?.reason).toMatch(/^The pair mirrors from 2026-03-01\. (No mirrored document matches this row\.|Possibly the same sale as mirrored document .*, which is NOT eliminated automatically for the period to 2026-03-31: this may be the sale's only elimination\.)$/);
  });

  it('no mirrored document at all (approved before the pair was on, or never sent): drafted and flagged', async () => {
    await turnOn();
    const [s] = await matchedPair();
    const g = await gen();
    expect([g.drafted.includes(s), g.skipped]).toEqual([true, []]);
    expect(g.flagged.find((f) => f.transactionId === s)?.reason).toBe('The pair mirrors from 2026-03-01. No mirrored document matches this row.');
  });

  it('re-judged at every run: skipped while the mirror stands; after the receiver reverses its bill (20 March) the next run drafts the row', async () => {
    await turnOn();
    const m = await L.accepted({ date: '2026-03-15' }); await redate(m.bill, '2026-03-15'); await L.approveBill(m.bill);
    const s = await manual(co.A, co.B, 'sale', '2026-03-15');
    await pool.query("UPDATE intercompany_transactions SET match_status = 'matched' WHERE id = $1", [s.id]);
    expect((await gen()).skipped).toEqual([s.id]);
    const je = (await pool.query('SELECT gl_journal_entry_id AS je FROM supplier_invoices WHERE id = $1', [m.bill])).rows[0].je as string;
    const rev = (await pool.query(`INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id)
      SELECT '2026-03-20', 'reversal', source, 'draft', created_by, company_id FROM gl_journal_entries WHERE id = $1 RETURNING id`, [je])).rows[0].id as string;
    await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description)
      SELECT $2, gl_account_id, credit, debit, company_id, 'reversal' FROM gl_journal_lines WHERE journal_entry_id = $1`, [je, rev]);
    await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now(), reversal_of_id = $2 WHERE id = $1", [rev, je]);
    const again = await gen();
    expect([again.skipped, again.drafted.includes(s.id)]).toEqual([[], true]);
  });

  it('one standing mirror, two manual sales of it: one is skipped, the other drafted (a mirror accounts for one sale)', async () => {
    await turnOn();
    const m = await L.accepted({ date: '2026-03-15' }); await redate(m.bill, '2026-03-15'); await L.approveBill(m.bill);
    const a = await manual(co.A, co.B, 'sale', '2026-03-15'); const b = await manual(co.A, co.B, 'sale', '2026-03-15');
    await pool.query("UPDATE intercompany_transactions SET match_status = 'matched' WHERE id = ANY($1)", [[a.id, b.id]]);
    const g = await gen();
    expect([g.skipped.length, g.drafted.filter((d) => d === a.id || d === b.id).length]).toEqual([1, 1]);
  });
});

describe('the mirror goes to the row it belongs to', () => {
  it('the only matching row two days off the mirror (12 March for 10 March): skipped, the mirror eliminates it', async () => {
    await turnOn();
    const m = await L.accepted({ date: '2026-03-10' }); await redate(m.bill, '2026-03-10'); await L.approveBill(m.bill);
    const r = await manual(co.A, co.B, 'sale', '2026-03-12');
    await pool.query("UPDATE intercompany_transactions SET match_status = 'matched' WHERE id = $1", [r.id]);
    expect((await gen()).skipped).toEqual([r.id]);
  });

  it('a mirror of 10 March and manual sales of 5 and 10 March (both match it, same month): the 10 March row is skipped, the 5 March row drafted', async () => {
    await turnOn();
    const m = await L.accepted({ date: '2026-03-10' }); await redate(m.bill, '2026-03-10'); await L.approveBill(m.bill);
    const early = await manual(co.A, co.B, 'sale', '2026-03-05'); const exact = await manual(co.A, co.B, 'sale', '2026-03-10');
    await pool.query("UPDATE intercompany_transactions SET match_status = 'matched' WHERE id = ANY($1)", [[early.id, exact.id]]);
    const g = await gen();
    expect([g.skipped, g.drafted.includes(early.id)]).toEqual([[exact.id], true]);
    // the drafted row's warning and its post refusal say why it was drafted (the mirror accounts for another row), never just "twice"
    const row = (await asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, '2026-03-01', '2026-03-31'))).find((a) => a.sourceIntercompanyId === early.id)!;
    expect([row.mirrorStands, row.pairCutover]).toEqual([true, '2026-03-01']);
    const refused = await asService(pool, U.ab, co.A, () => postEliminationAdjustment(row.id, co.G)).then(() => '', (e: Error) => e.message);
    expect(refused).toMatch(/which is eliminated automatically, but is matched to a different row \(the pair mirrors from 2026-03-01\)\. If it is the same sale, posting this would eliminate it twice/);
  });
});

describe('R14-H2: a pair in two groups has a cutover only in the group its mirrors go to (the oldest)', () => {
  it('the younger group G2 sees no cutover and skips nothing', async () => {
    await turnOn();
    const g2 = crypto.randomUUID();
    await pool.query("INSERT INTO company_groups(id, name, created_at) VALUES ($1, 'IC group G2 (younger)', now() + interval '1 day')", [g2]);
    await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3)', [g2, co.A, co.B]);
    try {
      const m = await L.accepted({ date: '2026-03-15' }); await redate(m.bill, '2026-03-15'); await L.approveBill(m.bill);
      expect([...(await asService(pool, U.ab, co.A, () => getPairCutovers(co.G))).values()]).toEqual(['2026-03-01']);
      expect((await asService(pool, U.ab, co.A, () => getPairCutovers(g2))).size).toBe(0);
      const r = await asService(pool, U.ab, co.A, () => createIntercompanyTransaction({ groupId: g2, sourceCompanyId: co.A, targetCompanyId: co.B,
        transactionType: 'sale', amount: 1000, transactionDate: '2026-03-15', description: 'G2 manual sale' }));
      await pool.query("UPDATE intercompany_transactions SET match_status = 'matched' WHERE id = $1", [r.id]);
      expect((await gen(g2)).skipped).toEqual([]);
    } finally {
      await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [g2]);
      await pool.query('DELETE FROM intercompany_transactions WHERE group_id = $1', [g2]);
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1', [g2]);
      await pool.query('DELETE FROM company_groups WHERE id = $1', [g2]);
    }
  });
});

describe('go-live and switching on', () => {
  it('a side switched on mirrors from the start of the NEXT Johannesburg day', async () => {
    const id = await conn();
    await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connection_sides SET supplier_id = $2 WHERE connection_id = $1 AND company_id = $3', [id, party.aSupplier, co.A]), true);
    const r = (await pool.query(`SELECT mirroring_since = (date_trunc('day', now() AT TIME ZONE 'Africa/Johannesburg') + interval '1 day') AT TIME ZONE 'Africa/Johannesburg' AS ok
      FROM intercompany_connection_sides WHERE connection_id = $1 AND company_id = $2`, [id, co.A])).rows[0];
    expect(r.ok).toBe(true);
  });
});

describe('R14 quality M2: the auto-accept attempt given back', () => {
  it('intercompany_auto_accept_release (app_service) takes one attempt off a pending message still at this run\'s attempt, and clears its back-off', async () => {
    const sent = await sentInvoice(pool, { date: '2026-03-15' });
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(
      "UPDATE intercompany_messages SET auto_attempts = 7, auto_next_attempt_at = now() + interval '1 hour' WHERE id = $1", [sent.id]));
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE app_service');
      // (round 16: only at the attempt this run's claim gave it; a message another run has claimed since, at 8, is left alone)
      expect((await c.query('SELECT public.intercompany_auto_accept_release($1::uuid[], $2::int[]) AS n', [[sent.id], [8]])).rows[0].n).toBe(0);
      expect((await c.query('SELECT public.intercompany_auto_accept_release($1::uuid[], $2::int[]) AS n', [[sent.id], [7]])).rows[0].n).toBe(1);
      await c.query('COMMIT');
    } finally { c.release(); }
    expect((await pool.query('SELECT auto_attempts, auto_next_attempt_at FROM intercompany_messages WHERE id = $1', [sent.id])).rows[0]).toEqual({ auto_attempts: 6, auto_next_attempt_at: null });
  });
});
