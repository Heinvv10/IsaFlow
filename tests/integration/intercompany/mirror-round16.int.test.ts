/**
 * Intercompany P2, round 16: the round-15 breaker's probes as asserting tests, against the STORED, exclusive row -> mirror link
 * (intercompany_mirror_link) judged as at the period being generated:
 *  H1  one mirror accounts for one sale across separately generated periods (monthly runs, half-month runs, a re-run);
 *  H2  a re-run of a past period after a reversal dated LATER keeps the row left to the mirror (March keeps the mirror's +E); a reversal
 *      inside the period releases the link and drafts the row;
 *  M1  a mirror whose derived event is dropped (an unmapped expense account) does not take the row;
 *  the link cannot be written by a session; a hand-made draft made before a cutover was moved earlier still posts (the reason is asked at
 *  creation only).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { createIntercompanyTransaction } from '../../../src/modules/accounting/services/reports/intercompanyService';
import { autoGenerateEliminations, type FlaggedEliminationRow, type SkippedEliminationRow } from '../../../src/modules/accounting/services/reports/eliminationGenerator';
import { createEliminationAdjustment, getEliminationAdjustments, postEliminationAdjustment } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { acc, asService, co, groupAccounts, U } from './mirror.helpers';
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

describe('H1: one mirror, one sale, across runs and periods (the link is stored)', () => {
  it('monthly runs: a 30 Mar sale (the mirror\'s) is left to it; a 3 Apr sale of the same amount is drafted in April', async () => {
    await turnOn();
    await booked('2026-03-30');
    const a = await manual(co.A, co.B, 'sale', '2026-03-30'); const b = await manual(co.A, co.B, 'sale', '2026-04-03');
    await matchRows([a.id, b.id]);
    expect((await gen('2026-03-01', '2026-03-31')).skipped).toEqual([a.id]);
    const apr = await gen('2026-04-01', '2026-04-30');
    expect([apr.skipped, apr.drafted.includes(b.id)]).toEqual([[], true]);
    expect(apr.flagged.find((f) => f.transactionId === b.id)?.reason).toMatch(/already eliminates another row/);
    expect(await activeLinks()).toEqual([a.id]);
  });

  it('April generated FIRST: the 3 Apr sale does not take the mirror from the closer 30 Mar sale, which gets it in March', async () => {
    await turnOn();
    await booked('2026-03-30');
    const a = await manual(co.A, co.B, 'sale', '2026-03-30'); const b = await manual(co.A, co.B, 'sale', '2026-04-03');
    await matchRows([a.id, b.id]);
    const apr = await gen('2026-04-01', '2026-04-30');
    expect([apr.skipped, apr.drafted.includes(b.id)]).toEqual([[], true]);
    expect(apr.flagged.find((f) => f.transactionId === b.id)?.reason).toMatch(/belongs to a closer row/);
    expect((await gen('2026-03-01', '2026-03-31')).skipped).toEqual([a.id]);
  });

  it('half-month runs: 5 Mar and 20 Mar sales, one mirror of 20 Mar: the 20 Mar sale is left to it, the 5 Mar one drafted', async () => {
    await turnOn();
    await booked('2026-03-20');
    const a = await manual(co.A, co.B, 'sale', '2026-03-05'); const b = await manual(co.A, co.B, 'sale', '2026-03-20');
    await matchRows([a.id, b.id]);
    const h1 = await gen('2026-03-01', '2026-03-15'); const h2 = await gen('2026-03-16', '2026-03-31');
    expect([h1.skipped, h1.drafted.includes(a.id), h2.skipped]).toEqual([[], true, [b.id]]);
  });

  it('a re-run reads the stored link: the same row stays left to the mirror, nothing is drafted', async () => {
    await turnOn();
    await booked('2026-03-20');
    const b = await manual(co.A, co.B, 'sale', '2026-03-20'); await matchRows([b.id]);
    expect((await gen('2026-03-01', '2026-03-31')).skipped).toEqual([b.id]);
    const again = await gen('2026-03-01', '2026-03-31');
    expect([again.skipped, again.drafted]).toEqual([[b.id], []]);
  });

  it('no session may write a link (only the definer does)', async () => {
    await turnOn();
    const m = await booked('2026-03-20');
    const b = await manual(co.A, co.B, 'sale', '2026-03-20');
    const row = m.message.payload.groupTransactionId as string;
    const err = await asAppUser(pool, U.ab, co.A, (q) => q.query("INSERT INTO intercompany_mirror_links(group_id, row_id, mirror_row, role) VALUES ($1, $2, $3, 'sale')", [co.G, b.id, row]), true)
      .then(() => 'inserted', (e: { code?: string }) => e.code);
    expect(err).toBe('42501');
  });
});

describe('H2: judged as at the period being generated', () => {
  it('a reversal dated in MAY: a re-run of MARCH keeps the row left to the mirror (March keeps its +E; May has the -E)', async () => {
    await turnOn();
    const m = await booked('2026-03-15');
    const s = await manual(co.A, co.B, 'sale', '2026-03-15'); await matchRows([s.id]);
    expect((await gen('2026-03-01', '2026-03-31')).skipped).toEqual([s.id]);
    await reverseBillOn(m.bill, '2026-05-20');
    const after = await gen('2026-03-01', '2026-03-31');
    expect([after.skipped, after.drafted]).toEqual([[s.id], []]);
  });

  it('a reversal dated INSIDE March: a re-run of March releases the link and drafts the row, saying why', async () => {
    await turnOn();
    const m = await booked('2026-03-15');
    const s = await manual(co.A, co.B, 'sale', '2026-03-15'); await matchRows([s.id]);
    expect((await gen('2026-03-01', '2026-03-31')).skipped).toEqual([s.id]);
    await reverseBillOn(m.bill, '2026-03-25');
    const after = await gen('2026-03-01', '2026-03-31');
    expect([after.skipped, after.drafted.includes(s.id)]).toEqual([[], true]);
    expect(after.flagged.find((f) => f.transactionId === s.id)?.reason).toMatch(/no longer eliminates this row for the period to 2026-03-31/);
    expect(await activeLinks()).toEqual([]);
  });

  it('the list and the post refusal judge a MARCH draft\'s mirror as at March (a May reversal does not make it "not eliminated")', async () => {
    const m = await booked('2026-03-15');   // (no cutover: a pre-cutover draft, flagged)
    const s = await manual(co.A, co.B, 'sale', '2026-03-15'); await matchRows([s.id]);
    await gen('2026-03-01', '2026-03-31');
    await reverseBillOn(m.bill, '2026-05-20');
    const row = (await asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, '2026-03-01', '2026-03-31'))).find((a) => a.sourceIntercompanyId === s.id)!;
    expect(row.mirrorStands).toBe(true);
    const refused = await asService(pool, U.ab, co.A, () => postEliminationAdjustment(row.id, co.G)).then(() => '', (e: Error) => e.message);
    expect(refused).toMatch(/which is eliminated automatically: posting this would eliminate the sale twice/);
  });
});

describe('M1: a mirror whose derived event is dropped does not take the row', () => {
  it('the receiver\'s expense account unmapped (another B expense account mapped): the row is drafted, not skipped', async () => {
    await turnOn();
    await booked('2026-03-15');
    const s = await manual(co.A, co.B, 'sale', '2026-03-15'); await matchRows([s.id]);
    await pool.query('UPDATE group_coa_mappings SET company_account_id = $2 WHERE group_id=$1 AND company_account_id = $3', [co.G, acc.bExp2, acc.bExp1]);
    try {
      const g = await gen('2026-03-01', '2026-03-31');
      expect([g.skipped, g.drafted.includes(s.id)]).toEqual([[], true]);
    } finally {
      await pool.query('UPDATE group_coa_mappings SET company_account_id = $3 WHERE group_id=$1 AND company_account_id = $2', [co.G, acc.bExp2, acc.bExp1]);
    }
  });
});

describe('INFO: a cutover moved earlier after a hand-made draft exists', () => {
  it('the draft (made with no reason, before any cutover applied) still posts: the reason is asked when an elimination is made', async () => {
    const made = await asService(pool, U.ab, co.A, () => createEliminationAdjustment(co.G, { adjustmentType: 'interco_revenue', description: 'by hand',
      periodStart: '2026-03-31', periodEnd: '2026-03-31', lines: [{ groupAccountId: groupAccounts.rev, debit: 10, credit: 0, description: '' }, { groupAccountId: groupAccounts.exp, debit: 0, credit: 10, description: '' }] }));
    await turnOn('2026-03-01');
    await asService(pool, U.ab, co.A, () => postEliminationAdjustment(made.id, co.G));
    expect((await pool.query('SELECT status, manual_reason FROM consolidation_adjustments WHERE id = $1', [made.id])).rows[0]).toEqual({ status: 'posted', manual_reason: null });
  });
});
