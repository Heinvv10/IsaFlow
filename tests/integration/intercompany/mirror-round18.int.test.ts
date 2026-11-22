/**
 * Intercompany P2, round 18: the round-17 breaker's probes as asserting tests.
 *  M1  a cancel and re-issue inside the period, then a re-run: the released link falls through to the row's other candidates (the re-issue
 *      takes the row, the period is eliminated once); before the cutover the flag names the candidate that stands for the period, never the
 *      cancelled one;
 *  M2  a 'closer' row counts only when the mirror can eliminate it in its own month; the wording says "matched to a different row" only while
 *      another row's active link holds the mirror;
 *  L2  (quality) the month-sum flag counts live documents only: a cancelled one never makes the sum.
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
const manual = (src: string, tgt: string, type: string, date: string, amount = 1000) => asService(pool, U.ab, src, () => createIntercompanyTransaction({
  groupId: co.G, sourceCompanyId: src, targetCompanyId: tgt, transactionType: type, amount, transactionDate: date, description: `Manual ${type} ${date}` }));
const matchRows = (ids: string[]) => pool.query("UPDATE intercompany_transactions SET match_status = 'matched' WHERE id = ANY($1)", [ids]);
async function gen(start: string, end: string) {
  const flagged: FlaggedEliminationRow[] = []; const skipped: SkippedEliminationRow[] = [];
  const made = await asService(pool, U.ab, co.A, () => autoGenerateEliminations(co.G, start, end, flagged, skipped));
  return { drafted: made.map((m) => m.sourceIntercompanyId), skipped: skipped.map((s) => s.transactionId), flagged };
}
type Over = Parameters<typeof L.accepted>[0];
async function booked(date: string, over: Over = {}) { const m = await L.accepted({ date, ...over }); await redate(m.bill, date); await L.approveBill(m.bill); return m; }
async function reverseBillOn(bill: string, date: string) {
  const je = (await pool.query('SELECT gl_journal_entry_id AS je FROM supplier_invoices WHERE id = $1', [bill])).rows[0].je as string;
  const rev = (await pool.query(`INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id)
    SELECT $2::date, 'reversal', source, 'draft', created_by, company_id FROM gl_journal_entries WHERE id = $1 RETURNING id`, [je, date])).rows[0].id as string;
  await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description)
    SELECT $2, gl_account_id, credit, debit, company_id, 'reversal' FROM gl_journal_lines WHERE journal_entry_id = $1`, [je, rev]);
  await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now(), reversal_of_id = $2 WHERE id = $1", [rev, je]);
}
/** The mirror's group row and its description (the name the flag and the link use). */
const mirrorOf = async (m: { message: { group_transaction_id: string } }) =>
  (await pool.query('SELECT id, description FROM intercompany_transactions WHERE id = $1', [m.message.group_transaction_id])).rows[0] as { id: string; description: string };
const activeLinks = async () => (await pool.query('SELECT row_id, mirror_row FROM intercompany_mirror_links WHERE group_id = $1 AND released_at IS NULL ORDER BY linked_at', [co.G])).rows;
const total = async (s: string, e: string) => {
  const rows = await asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, s, e));
  const pick = (a: { automatic?: boolean; status: string }) => a.automatic || a.status === 'posted';
  return rows.filter(pick).reduce((x, a) => x + a.lines.reduce((y, l) => y + Number(l.debit), 0), 0);
};
const listed = async (row: string, s: string, e: string) => (await asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, s, e))).find((a) => a.sourceIntercompanyId === row)!;
const post = (id: string, confirm = false) => asService(pool, U.ab, co.A, () => postEliminationAdjustment(id, co.G, confirm)).then(() => 'posted', (e: Error) => `REFUSED: ${e.message}`);
const reversalDates = async (m: { message: { source_journal_entry_id: string } }) =>
  (await pool.query("SELECT entry_date::text AS d FROM gl_journal_entries WHERE reversal_of_id = $1 AND status = 'posted'", [m.message.source_journal_entry_id])).rows.map((r) => r.d as string);

describe('M1: a cancel and re-issue inside the period', () => {
  it('a RE-RUN of March: the released link falls through to the re-issue, the row is skipped and March is eliminated once', async () => {
    await turnOn();
    const m1 = await booked('2026-03-15');
    const s = await manual(co.A, co.B, 'sale', '2026-03-15'); await matchRows([s.id]);
    expect((await gen('2026-03-01', '2026-03-31')).skipped).toEqual([s.id]);
    await L.cancelSender(m1.inv.id);
    expect(await reversalDates(m1)).toEqual(['2026-03-15']);   // (the cancel is reversed inside March)
    const m3 = await booked('2026-03-16');
    const again = await gen('2026-03-01', '2026-03-31');
    expect([again.skipped, again.drafted]).toEqual([[s.id], []]);
    expect(await activeLinks()).toEqual([{ row_id: s.id, mirror_row: (await mirrorOf(m3)).id }]);
    expect(await total('2026-03-01', '2026-03-31')).toBe(1000);
  });

  it('a FIRST run of March after the same cancel and re-issue links the re-issue (the same answer as the re-run)', async () => {
    await turnOn();
    const m1 = await booked('2026-03-15');
    const s = await manual(co.A, co.B, 'sale', '2026-03-15'); await matchRows([s.id]);
    await L.cancelSender(m1.inv.id);
    const m3 = await booked('2026-03-16');
    const g = await gen('2026-03-01', '2026-03-31');
    expect([g.skipped, g.drafted]).toEqual([[s.id], []]);
    expect(await activeLinks()).toEqual([{ row_id: s.id, mirror_row: (await mirrorOf(m3)).id }]);
    expect(await total('2026-03-01', '2026-03-31')).toBe(1000);
  });

  it('a re-run after a cancel with NO re-issue: the link is released and the row drafted, saying the mirror no longer eliminates it', async () => {
    await turnOn();
    const m1 = await booked('2026-03-15');
    const s = await manual(co.A, co.B, 'sale', '2026-03-15'); await matchRows([s.id]);
    expect((await gen('2026-03-01', '2026-03-31')).skipped).toEqual([s.id]);
    await L.cancelSender(m1.inv.id);
    const again = await gen('2026-03-01', '2026-03-31');
    expect([again.skipped, again.drafted]).toEqual([[], [s.id]]);
    expect(again.flagged.find((f) => f.transactionId === s.id)?.reason).toMatch(/that mirror did not eliminate this row for the period to 2026-03-31/);
    expect(await activeLinks()).toEqual([]);
  });

  it('PRE-cutover: the flag names the re-issue that stands (eliminated automatically), never the cancelled mirror', async () => {
    await turnOn('2026-03-01');
    const m1 = await booked('2026-03-02');
    await L.cancelSender(m1.inv.id);
    expect(await reversalDates(m1)).toEqual(['2026-03-02']);
    const m3 = await booked('2026-03-03');
    const pre = await manual(co.A, co.B, 'sale', '2026-02-28'); await matchRows([pre.id]);
    const g = await gen('2026-02-01', '2026-02-28');
    const want = (await mirrorOf(m3)).description;
    expect(want).not.toBe((await mirrorOf(m1)).description);
    expect(g.flagged.map((f) => [f.transactionId, f.mirroredRef])).toEqual([[pre.id, want]]);
    // (round 20, M3: the re-issue of 3 March is eliminated on its own date, after the February period, and the wording says so)
    expect(g.flagged[0]!.reason).toMatch(/, which is eliminated automatically on 2026-03-03, after the period to 2026-02-28, and is not matched to any row yet\. If it is the same sale, posting this would eliminate it twice\.$/);
    const row = await listed(pre.id, '2026-02-01', '2026-02-28');
    expect([row.mirroredDuplicateOf, row.mirrorStands, row.pairCutover]).toEqual([want, true, null]);
    expect(await post(row.id)).toMatch(new RegExp(`REFUSED: Possibly the same sale as mirrored document ${want.replace(/[()]/g, '\\$&')}, which is eliminated automatically on 2026-03-03, after the period to 2026-02-28, and is not matched to any row yet\\. If it is the same sale, posting this would eliminate it twice`));
  });
});

describe('M2: a closer row counts only if the mirror can eliminate it', () => {
  it('the closer row\'s own month cannot take the mirror (its bill reversed in April): the March row takes it, March is eliminated once', async () => {
    await turnOn('2026-03-01');
    const m = await booked('2026-03-31');
    const r = await manual(co.A, co.B, 'sale', '2026-03-25'); const x = await manual(co.A, co.B, 'sale', '2026-04-01');
    await matchRows([r.id, x.id]);
    await reverseBillOn(m.bill, '2026-04-10');
    const mar = await gen('2026-03-01', '2026-03-31');
    expect([mar.skipped, mar.drafted]).toEqual([[r.id], []]);
    expect(await activeLinks()).toEqual([{ row_id: r.id, mirror_row: (await mirrorOf(m)).id }]);
    const apr = await gen('2026-04-01', '2026-04-30');
    expect([apr.skipped, apr.drafted]).toEqual([[], [x.id]]);
    expect(await total('2026-03-01', '2026-03-31')).toBe(1000);
  });

  it('a genuine closer row not yet run: "not matched to any row yet", never "matched to a different row"; once its period links it, the wording says so', async () => {
    await turnOn('2026-03-01');
    await booked('2026-03-31');
    const r = await manual(co.A, co.B, 'sale', '2026-03-25'); const x = await manual(co.A, co.B, 'sale', '2026-04-01');
    await matchRows([r.id, x.id]);
    const mar = await gen('2026-03-01', '2026-03-31');
    expect([mar.skipped, mar.drafted]).toEqual([[], [r.id]]);
    expect(mar.flagged.find((f) => f.transactionId === r.id)?.reason).toMatch(/belongs to a closer row/);
    const before = await listed(r.id, '2026-03-01', '2026-03-31');
    expect([before.mirrorStands, before.pairCutover, before.mirrorLinked]).toEqual([true, '2026-03-01', false]);
    const refused = await post(before.id);
    expect(refused).toMatch(/which is eliminated automatically and is not matched to any row yet \(the pair mirrors from 2026-03-01\)\. If it is the same sale, posting this would eliminate it twice/);
    expect(refused).not.toMatch(/matched to a different row/);
    expect((await gen('2026-04-01', '2026-04-30')).skipped).toEqual([x.id]);
    const after = await listed(r.id, '2026-03-01', '2026-03-31');
    expect(after.mirrorLinked).toBe(true);
    expect(await post(after.id)).toMatch(/which is eliminated automatically, but is matched to a different row \(the pair mirrors from 2026-03-01\)/);
  });
});

describe('L2 (quality): the month sum counts live documents only', () => {
  it('a live R600 and a CANCELLED R400 mirror in January never flag a manual R1 000 sale as "2 mirrored documents"; the live pair still does', async () => {
    // (subtotals 600 and 400: the invoice lines; the manual rows' amounts are subtotals)
    await booked('2026-01-10', { lines: [['Fee', 1, 600]] });
    const gone = await booked('2026-01-12', { lines: [['Fee', 1, 400]] });
    await L.cancelSender(gone.inv.id);
    const s = await manual(co.A, co.B, 'sale', '2026-01-20', 1000); await matchRows([s.id]);
    const g = await gen('2026-01-01', '2026-01-31');
    expect(g.drafted).toContain(s.id);
    expect(g.flagged.filter((f) => f.transactionId === s.id)).toEqual([]);
    // the control: a second LIVE R400 makes the sum, and the flag names the month's two live documents
    await booked('2026-01-14', { lines: [['Fee', 1, 400]] });
    const row = await listed(s.id, '2026-01-01', '2026-01-31');
    expect(row.mirroredDuplicateOf).toBe('2 mirrored documents of January 2026');
  });
});

describe('L5 (quality): the link holds its as-at date to [the row\'s date, today], today being the Johannesburg day', () => {
  // the as-at date the link used is what it stamps on a release (released_for): a planted link to a row that is no mirror never holds
  async function releasedFor(rowDate: string, asat: string | null, timeZone = 'Africa/Johannesburg') {
    await turnOn('2026-03-01');
    const r = await manual(co.A, co.B, 'sale', rowDate);
    const other = await manual(co.B, co.A, 'sale', '2026-03-02');
    await matchRows([r.id]);
    await pool.query("INSERT INTO intercompany_mirror_links (group_id, row_id, mirror_row, role, linked_by) VALUES ($1, $2, $3, 'sale', 'planted')", [co.G, r.id, other.id]);
    const state = await asAppUser(pool, U.ab, co.A, async (q) => {
      await q.query(`SET LOCAL TimeZone = '${timeZone}'`);
      return (await q.query('SELECT state FROM public.intercompany_mirror_link($1, $2::date)', [r.id, asat])).rows[0].state as string;
    }, true);
    const link = (await pool.query('SELECT released_for::text AS d FROM intercompany_mirror_links WHERE row_id = $1', [r.id])).rows[0];
    return { state, releasedFor: link.d as string };
  }
  const jhbToday = async () => (await pool.query("SELECT (now() AT TIME ZONE 'Africa/Johannesburg')::date::text AS d")).rows[0].d as string;
  const plusDays = async (d: string, n: number) => (await pool.query('SELECT ($1::date + $2::int)::text AS d', [d, n])).rows[0].d as string;

  it('a row dated in the FUTURE: the as-at date is the row\'s own date (never a date before it)', async () => {
    const today = await jhbToday();
    const rowDate = await plusDays(today, 3);
    if (rowDate.slice(0, 4) !== '2026') await L.monthly(co.A, Number(rowDate.slice(0, 4)));   // (a run in late December)
    expect(await releasedFor(rowDate, await plusDays(today, 40))).toEqual({ state: 'released', releasedFor: rowDate });
  });

  it('"today" is the Johannesburg day, not the session\'s: in a zone whose date differs, an as-at past today is held to Johannesburg\'s today', async () => {
    // one of these two zones is on another calendar day than Johannesburg at every moment (UTC+14 from 12:00 SAST, UTC-12 before 14:00 SAST);
    // Johannesburg's day and both zones' days are read in ONE statement (one now()), so a run crossing midnight cannot split them
    const days = (await pool.query(`SELECT (now() AT TIME ZONE 'Africa/Johannesburg')::date::text AS jhb, (now() AT TIME ZONE 'Pacific/Kiritimati')::date::text AS kiri,
                                           (now() AT TIME ZONE 'Etc/GMT+12')::date::text AS m12`)).rows[0] as { jhb: string; kiri: string; m12: string };
    const today = days.jhb;
    const zone = days.kiri !== today ? 'Pacific/Kiritimati' : days.m12 !== today ? 'Etc/GMT+12' : '';
    expect(zone).not.toBe('');
    expect(await releasedFor('2026-03-15', null, zone)).toEqual({ state: 'released', releasedFor: today });
  });
});
