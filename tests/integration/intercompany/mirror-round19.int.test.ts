/**
 * Intercompany P2, round 19: the round-18 breaker's probes as asserting tests. Every sentence about a possible mirrored duplicate (the
 * generator's note, the list's badge, the 409) is worded from the row's verified mirror facts (intercompany_mirror_facts, mirrorFacts.ts).
 *  M1  a month sum of which only part stands: "R600 of R1 000 is eliminated automatically", never "NOT eliminated ... the only elimination";
 *  M2  after the cutover, a month sum that stands in full is drafted (no set link: the stated limit) saying it is eliminated in full and that
 *      posting would eliminate it twice, never "is not eliminated automatically";
 *  L1  before the cutover the flag never names a standing mirror another row's link holds over the row's own (unapproved) mirror; a mirror
 *      linked LATER IN THE SAME RUN is worded "matched to a different row" (the flags are worded after every link of the run).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { createIntercompanyTransaction } from '../../../src/modules/accounting/services/reports/intercompanyService';
import { autoGenerateEliminations, type FlaggedEliminationRow, type SkippedEliminationRow } from '../../../src/modules/accounting/services/reports/eliminationGenerator';
import { getEliminationAdjustments, postEliminationAdjustment } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { duplicateBadgeText } from '../../../src/modules/accounting/services/reports/mirrorFacts';
import { formatMoney as R } from '../../../src/lib/money/formatMoney';
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
/** The pair's cutover is the later of `cutover` and `since` (both sides' mirroring_since). */
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
const manual = (date: string, amount = 1000) => asService(pool, U.ab, co.A, () => createIntercompanyTransaction({
  groupId: co.G, sourceCompanyId: co.A, targetCompanyId: co.B, transactionType: 'sale', amount, transactionDate: date, description: `Manual sale ${date}` }));
const matchRows = (ids: string[]) => pool.query("UPDATE intercompany_transactions SET match_status = 'matched' WHERE id = ANY($1)", [ids]);
async function gen(start: string, end: string) {
  const flagged: FlaggedEliminationRow[] = []; const skipped: SkippedEliminationRow[] = [];
  const made = await asService(pool, U.ab, co.A, () => autoGenerateEliminations(co.G, start, end, flagged, skipped));
  return { drafted: made.map((m) => m.sourceIntercompanyId), skipped: skipped.map((s) => s.transactionId), flagged, made };
}
/** A mirror of `price` (one line: its subtotal) dated `date`; its bill approved unless `approve` is false. Returns its description. */
async function mirror(date: string, price: number, approve = true) {
  const m = await L.accepted({ date, lines: [['Item', 1, price]] });
  await redate(m.bill, date);
  if (approve) await L.approveBill(m.bill);
  return (await pool.query('SELECT description FROM intercompany_transactions WHERE id = $1', [m.message.group_transaction_id])).rows[0].description as string;
}
const listed = async (row: string) => (await asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, '2026-03-01', '2026-03-31'))).find((a) => a.sourceIntercompanyId === row)!;
const post = (id: string, confirm = false) => asService(pool, U.ab, co.A, () => postEliminationAdjustment(id, co.G, confirm)).then(() => 'posted', (e: Error) => `REFUSED: ${e.message}`);
const total = async () => {
  const rows = await asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, '2026-03-01', '2026-03-31'));
  return rows.filter((a) => a.automatic || a.status === 'posted').reduce((x, a) => x + a.lines.reduce((y, l) => y + Number(l.debit), 0), 0);
};
const activeLinks = async () => (await pool.query('SELECT row_id FROM intercompany_mirror_links WHERE group_id = $1 AND released_at IS NULL', [co.G])).rows.map((r) => r.row_id as string);
const jhbToday = async () => (await pool.query("SELECT (now() AT TIME ZONE 'Africa/Johannesburg')::date::text AS d")).rows[0].d as string;
const facts = (a: Awaited<ReturnType<typeof listed>>) => a.mirrorFacts!.mirrors.map((m) => [m.ref, m.amount, m.stands, m.link]);

describe('M1: a month sum of which only part stands', () => {
  it('before the cutover: the note, the badge and the 409 say R600 of R1 000 is eliminated automatically, never "NOT eliminated ... only elimination"', async () => {
    await turnOn('2026-03-01', '2026-03-15');                         // (the cutover is 15 March: a row of 10 March is before it)
    const a = await mirror('2026-03-02', 600);
    const b = await mirror('2026-03-03', 400, false);                 // (its bill is not approved: it does not stand)
    const r = await manual('2026-03-10'); await matchRows([r.id]);
    expect(await total()).toBe(600);
    const g = await gen('2026-03-01', '2026-03-31');
    expect(g.drafted).toEqual([r.id]);
    const sentence = `Possibly the same sale as 2 mirrored documents of March 2026: ${a} (${R(600)}: eliminated automatically, not matched to any row yet) and `
      + `${b} (${R(400)}: NOT eliminated automatically for the period to 2026-03-31). ${R(600)} of ${R(1000)} is eliminated automatically by mirroring: `
      + 'if it is the same sale, posting this in full would eliminate that part twice.';
    expect(g.flagged.map((f) => [f.transactionId, f.mirroredRef, f.reason])).toEqual([[r.id, '2 mirrored documents of March 2026', sentence]]);
    const row = await listed(r.id);
    expect(row.description).toContain(`CHECK BEFORE POSTING (as found by the run of ${await jhbToday()}): ${sentence} - `);
    expect(facts(row)).toEqual([[a, 600, true, 'none'], [b, 400, false, 'none']]);
    expect(duplicateBadgeText(row.mirrorFacts!, row.status, row.pairCutover ?? null)).toBe(`${sentence} Check before posting.`);
    const refused = await post(row.id);
    expect(refused).toBe(`REFUSED: ${sentence} Confirm to post it.`);
    expect(refused).not.toMatch(/only elimination|at the moment/);
  });
});

describe('M2: after the cutover, a month sum that stands in full', () => {
  it('is drafted (no set link: the stated limit) saying all of them are eliminated automatically and posting would eliminate it twice', async () => {
    await turnOn('2026-03-01');
    const a = await mirror('2026-03-02', 600);
    const b = await mirror('2026-03-03', 400);
    const r = await manual('2026-03-10'); await matchRows([r.id]);
    expect(await total()).toBe(1000);
    const g = await gen('2026-03-01', '2026-03-31');
    expect([g.drafted, g.skipped, await activeLinks()]).toEqual([[r.id], [], []]);
    const list = `2 mirrored documents of March 2026: ${a} (${R(600)}: eliminated automatically, not matched to any row yet) and ${b} (${R(400)}: eliminated automatically, not matched to any row yet)`;
    const tail = 'All of them are eliminated automatically by mirroring: if it is the same sale, posting this would eliminate it twice.';
    expect(g.flagged[0]!.reason).toBe(`The pair mirrors from 2026-03-01. Possibly the same sale as ${list}. ${tail}`);
    expect(g.flagged[0]!.reason).not.toMatch(/is not eliminated automatically|mirrored document 2 mirrored documents/);
    const row = await listed(r.id);
    expect(row.pairCutover).toBe('2026-03-01');
    expect(await post(row.id)).toBe(`REFUSED: Possibly the same sale as ${list} (the pair mirrors from 2026-03-01). ${tail} Confirm to post it.`);
    expect(await total()).toBe(1000);
  });
});

describe('L1: before the cutover the flag never names another row\'s mirror over the row\'s own', () => {
  it('the row\'s own (unapproved) mirror is named NOT eliminated; the standing mirror the later row linked is not named', async () => {
    await turnOn('2026-03-01', '2026-03-15');
    const own = await mirror('2026-03-10', 1000, false);
    const theirs = await mirror('2026-03-15', 1000);
    const r = await manual('2026-03-10'); const s = await manual('2026-03-15'); await matchRows([r.id, s.id]);
    const g = await gen('2026-03-01', '2026-03-31');
    expect([g.skipped, g.drafted]).toEqual([[s.id], [r.id]]);
    const sentence = `Possibly the same sale as mirrored document ${own}, which is NOT eliminated automatically for the period to 2026-03-31: this may be the sale's only elimination.`;
    expect(g.flagged.map((f) => [f.mirroredRef, f.reason])).toEqual([[own, sentence]]);
    const row = await listed(r.id);
    expect(facts(row)).toEqual([[own, 1000, false, 'none']]);
    expect(await post(row.id)).toBe(`REFUSED: ${sentence} Confirm to post it.`);
    expect(JSON.stringify(row.mirrorFacts)).not.toContain(theirs);
  });

  it('the row\'s own mirror is FARTHER than the standing one another row\'s link holds: the own one is still named, NOT eliminated', async () => {
    await turnOn('2026-03-01', '2026-03-15');
    const own = await mirror('2026-03-10', 1000, false);            // (4 days from the row)
    const theirs = await mirror('2026-03-15', 1000);                // (1 day from the row: the closest candidate)
    const r = await manual('2026-03-14'); const s = await manual('2026-03-15'); await matchRows([r.id, s.id]);
    const g = await gen('2026-03-01', '2026-03-31');
    expect([g.skipped, g.drafted]).toEqual([[s.id], [r.id]]);
    expect(g.flagged.map((f) => f.mirroredRef)).toEqual([own]);
    expect(facts(await listed(r.id))).toEqual([[own, 1000, false, 'none']]);
    expect(g.flagged[0]!.reason).not.toContain(theirs);
  });

  it('a row whose only match is a standing mirror a LATER row of the same run links: "matched to a different row", never "not matched to any row yet"', async () => {
    await turnOn('2026-03-01', '2026-03-15');
    const theirs = await mirror('2026-03-15', 1000);
    const r = await manual('2026-03-10'); const s = await manual('2026-03-15'); await matchRows([r.id, s.id]);
    const g = await gen('2026-03-01', '2026-03-31');
    expect([g.skipped, g.drafted]).toEqual([[s.id], [r.id]]);
    const sentence = `Possibly the same sale as mirrored document ${theirs}, which is eliminated automatically, but is matched to a different row. If it is the same sale, posting this would eliminate it twice.`;
    expect(g.flagged.map((f) => f.reason)).toEqual([sentence]);
    const row = await listed(r.id);
    expect(row.description).toContain(`CHECK BEFORE POSTING (as found by the run of ${await jhbToday()}): ${sentence} - `);
    expect(facts(row)).toEqual([[theirs, 1000, true, 'elsewhere']]);
    expect(await post(row.id)).toBe(`REFUSED: ${sentence} Confirm to post it.`);
  });
});
