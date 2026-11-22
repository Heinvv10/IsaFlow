/**
 * Intercompany P2, round 28 (blind review of 4a760b4997), M1: can a month SUM (the row's amount is the sum of several mirrors of its month) hold a
 * member whose sender-cancel is effective as at the period end?
 *   - A cancel dated INSIDE the period (the document's cancel, or a bare ledger reversal: both stamp the message) takes the member OUT of the sum
 *     (intercompany_mirrored_duplicate judges it as at the period end), so no sum of cancelled members is formed. A cancel dated AFTER the period
 *     leaves the member in and not "cancelled" (the period still carries it).
 *   - REACHABLE: a period that ends AFTER today, with members reversed today and revived by a journal dated in the future (before the period end).
 *     The sum judges each member as at the period end (revived: in), the facts as at LEAST(period end, today) (reversed: cancelled, nothing eliminated).
 *     The sentence is then the conditional one (no revenue left to eliminate if it is the same sale; if another sale it still needs this elimination),
 *     said as at TODAY (round 29 L1: the date actually judged), with a note that a journal dated up to the period end may change it.
 *     Every date of that scenario is derived from today (round 29 M1: a fixed future date turned the check red from that date on), and the revival's
 *     own fiscal period is created when none covers it (the fixtures' year ends on 31 December).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { autoGenerateEliminations, type FlaggedEliminationRow } from '../../../src/modules/accounting/services/reports/eliminationGenerator';
import { getEliminationAdjustments, postEliminationAdjustment } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { formatMoney as R } from '../../../src/lib/money/formatMoney';
import { createIntercompanyTransaction } from '../../../src/modules/accounting/services/reports/intercompanyService';
import { asService, co, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';
import { asAppUser, party, withoutTrigger } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
beforeAll(async () => { await L.setup(); await L.monthly(co.A, 2026); await L.monthly(co.B, 2026); }, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);
/** An open period for the sender covering `date` when none does (the 2026 fixtures end on 31 December); the shared cleanup removes it with the company. */
async function ensurePeriod(date: string) {
  if ((await pool.query('SELECT 1 FROM fiscal_periods WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date', [co.A, date])).rowCount) return;
  await pool.query(`INSERT INTO fiscal_periods(company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
    VALUES ($1, $2, 1, EXTRACT(YEAR FROM $3::date)::int, $3::date, $3::date, 'open')`, [co.A, `IC28 ${date}`, date]);
}

const conn = async () => (await pool.query("SELECT id FROM intercompany_connections WHERE status <> 'revoked' AND $1 IN (company_low_id, company_high_id) AND $2 IN (company_low_id, company_high_id)", [co.A, co.B])).rows[0].id as string;
async function turnOn(cutover: string) {
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
const manual = async (date: string, amount: number) => {
  const t = await asService(pool, U.ab, co.A, () => createIntercompanyTransaction({
    groupId: co.G, sourceCompanyId: co.A, targetCompanyId: co.B, transactionType: 'sale', amount, transactionDate: date, description: `Manual sale ${date}` }));
  await pool.query("UPDATE intercompany_transactions SET match_status = 'matched' WHERE id = $1", [t.id]);
  return t.id as string;
};
async function booked(date: string, price: number) {
  const m = await L.accepted({ date, lines: [['Item', 1, price]] });
  await redate(m.bill, date); await L.approveBill(m.bill);
  return m;
}
const asMember = <T>(fn: (q: { query: (s: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }) => Promise<T>) => asAppUser(pool, U.ab, co.A, fn as never, true) as Promise<T>;
const facts = (row: string, asat: string | null) => asMember(async (q) => (await q.query(
  'SELECT is_sum, ord, mirror_ref, amount::float8 AS amount, stands, sender_cancelled FROM public.intercompany_mirror_facts($1, $2::date) ORDER BY ord', [row, asat])).rows);
const dup = (row: string, asat: string | null) => asMember(async (q) => (await q.query('SELECT is_sum, cardinality(mirror_rows) AS n FROM public.intercompany_mirrored_duplicate($1, $2::date)', [row, asat])).rows);
const refOf = async (m: { message: { group_transaction_id: string } }) =>
  (await pool.query('SELECT description FROM intercompany_transactions WHERE id = $1', [m.message.group_transaction_id])).rows[0].description as string;
const reversalOf = async (je: string) => (await pool.query("SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1 AND status = 'posted'", [je])).rows[0].id as string;
/** The sender revives the cancelled sale: its reversal journal is reversed on `date` (the chain's third journal). */
async function reviveOn(je: string, date: string) {
  const rev = (await pool.query(`INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id)
    SELECT $2::date, 'reversal', source, 'draft', created_by, company_id FROM gl_journal_entries WHERE id = $1 RETURNING id`, [je, date])).rows[0].id as string;
  await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description)
    SELECT $2, gl_account_id, credit, debit, company_id, 'reversal' FROM gl_journal_lines WHERE journal_entry_id = $1`, [je, rev]);
  await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now(), reversal_of_id = $2 WHERE id = $1", [rev, je]);
}
/** The sender's cancel with its reversal ROLLED to today (a VAT-locked April-May). */
async function cancelRolled(inv: string) {
  await pool.query("INSERT INTO vat_period_locks(company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by, actor_type) VALUES ($1, '2026-04-01', '2026-05-31', 0, 0, 0, now(), $2, 'human')", [co.A, U.a]);
  try { await L.cancelSender(inv); } finally { await pool.query('DELETE FROM vat_period_locks WHERE company_id = $1', [co.A]); }
}
async function twoApril() {
  await turnOn('2026-03-01');
  const a = await booked('2026-04-10', 1000); const b = await booked('2026-04-12', 500);
  return { a, b, r: await manual('2026-04-20', 1500) };
}

describe('M1: a month sum never forms from members whose cancel is dated inside the period', () => {
  it('both cancelled INSIDE April by the document\'s cancel: no sum is formed (no facts), so the row is not flagged and no sentence is reachable', async () => {
    const { a, b, r } = await twoApril();
    expect((await facts(r, '2026-04-30')).map((f) => [f.is_sum, f.stands, f.sender_cancelled]), 'before any cancel: a sum of both').toEqual([[true, true, false], [true, true, false]]);
    await L.cancelSender(a.inv.id); await L.cancelSender(b.inv.id);
    expect(await facts(r, '2026-04-30')).toEqual([]);
    expect(await dup(r, '2026-04-30')).toEqual([]);
  });

  it('both reversed in the LEDGER only inside April (no document cancel): the hook stamps the message all the same, so the sum is not formed either', async () => {
    const { a, b, r } = await twoApril();
    await L.senderReverse(a.inv.id); await L.senderReverse(b.inv.id);
    expect(await dup(r, '2026-04-30')).toEqual([]);
    expect(await facts(r, '2026-04-30')).toEqual([]);
  });

  it('A cancelled inside April, B and C stand (R = B + C): the sum is B and C only, neither cancelled', async () => {
    await turnOn('2026-03-01');
    const a = await booked('2026-04-10', 1000); const b = await booked('2026-04-12', 500); const c = await booked('2026-04-14', 300);
    const r = await manual('2026-04-20', 800);
    await L.cancelSender(a.inv.id);
    const f = await facts(r, '2026-04-30');
    expect(f.map((x) => [x.mirror_ref, x.amount, x.stands, x.sender_cancelled])).toEqual([[await refOf(b), 500, true, false], [await refOf(c), 300, true, false]]);
  });

  it('both cancelled AFTER the period (rolled to today): April still carries them, so they are in the sum and not cancelled as at 30 April', async () => {
    const { a, b, r } = await twoApril();
    await cancelRolled(a.inv.id); await cancelRolled(b.inv.id);
    expect((await facts(r, '2026-04-30')).map((x) => [x.amount, x.stands, x.sender_cancelled])).toEqual([[1000, true, false], [500, true, false]]);
    // a period that ends on or before today is judged at its own end
    expect((await asMember(async (q) => (await q.query("SELECT DISTINCT judged_at::text AS j FROM public.intercompany_mirror_facts($1, '2026-04-30'::date)", [r])).rows))).toEqual([{ j: '2026-04-30' }]);
  });
});

/** Johannesburg's today (the date the functions clamp to) and a date `days` after it: every date of the reachable scenario is relative, so it holds on any day the suite runs. */
const dayFromToday = async (days: number) => (await pool.query("SELECT ((now() AT TIME ZONE 'Africa/Johannesburg')::date + $1::int)::text AS d", [days])).rows[0].d as string;

describe('M1 (reachable): the period ends after today and a journal dated in the future revives the cancelled members', () => {
  const REVIVE_DAYS = 10; const END_DAYS = 40;   // (revival after today, before the period end)
  const dates = async () => ({ today: await dayFromToday(0), revive: await dayFromToday(REVIVE_DAYS), end: await dayFromToday(END_DAYS) });
  async function revived() {
    const t = await twoApril();
    const d = await dates();
    await L.cancelSender(t.a.inv.id); await L.cancelSender(t.b.inv.id);
    await ensurePeriod(d.revive);
    for (const m of [t.a, t.b]) await reviveOn(await reversalOf(m.message.source_journal_entry_id), d.revive);
    return { ...t, ...d };
  }
  // the cancels are judged as at LEAST(period end, today) = today (the revival is in the future), so every sentence says today, then the revive note
  const sentence = (d: { today: string; end: string }, a: string, b: string, cut = '') => {
    const canc = `cancelled by the sender (its journal is reversed as at ${d.today})`;
    return `Possibly the same sale as 2 mirrored documents of April 2026: ${a} (${R(1000)}: ${canc}) and ${b} (${R(500)}: ${canc})${cut}. `
      + `A journal dated up to ${d.end} may change this: a mirror it revives is eliminated automatically for the period, and posting this would eliminate it twice. `
      + 'If it is the same sale there is no revenue left to eliminate: do not post this (a posted elimination would be an over-elimination to reverse). If it is another sale, it still needs this elimination.';
  };

  it('the sum is formed (as at the period end the members are revived) and the facts say each is cancelled as at today, nothing eliminated', async () => {
    const { r, end, today } = await revived();
    expect((await dup(r, end)).map((d) => [d.is_sum, d.n])).toEqual([[true, 2]]);
    const f = await asMember(async (q) => (await q.query('SELECT stands, sender_cancelled, judged_at::text AS judged_at FROM public.intercompany_mirror_facts($1, $2::date) ORDER BY ord', [r, end])).rows);
    expect(f).toEqual([{ stands: false, sender_cancelled: true, judged_at: today }, { stands: false, sender_cancelled: true, judged_at: today }]);
    expect((await facts(r, end)).map((x) => [x.amount, x.stands, x.sender_cancelled])).toEqual([[1000, false, true], [500, false, true]]);
  });

  it('the run drafts the row flagged with the conditional sentence; the stored draft\'s confirm and the list carry the same words; never "only elimination"', async () => {
    const { a, b, r, end, today } = await revived();
    const flagged: FlaggedEliminationRow[] = [];
    const made = await asService(pool, U.ab, co.A, () => autoGenerateEliminations(co.G, '2026-04-01', end, flagged, []));
    expect(made.map((m) => m.sourceIntercompanyId)).toEqual([r]);
    const [refA, refB] = [await refOf(a), await refOf(b)];
    const words = sentence({ today, end }, refA, refB);
    expect(flagged.map((f) => [f.transactionId, f.reason])).toEqual([[r, `The pair mirrors from 2026-03-01. ${words}`]]);
    expect(flagged[0]!.reason).not.toMatch(/only elimination|None of them|NOT eliminated|reversed as at 2026-04/);
    const row = (await asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, '2026-04-01', end))).find((x) => x.sourceIntercompanyId === r)!;
    expect(row.mirrorFacts?.mirrors.map((m) => [m.stands, m.senderCancelled])).toEqual([[false, true], [false, true]]);
    expect(row.mirrorFacts?.judgedAt).toBe(today);
    const refused = await asService(pool, U.ab, co.A, () => postEliminationAdjustment(row.id, co.G, false)).then(() => 'posted', (e: Error) => e.message);
    expect(refused).toBe(`${sentence({ today, end }, refA, refB, ' (the pair mirrors from 2026-03-01)')} Confirm to post it.`);
  });
});
