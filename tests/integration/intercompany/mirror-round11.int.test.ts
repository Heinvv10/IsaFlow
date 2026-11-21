/**
 * Intercompany P2, round 11 (the round-10 breaker review):
 *  B-M1  a rejected mirror (A1) and a loan (A2) never touch a genuine manual elimination: drafted, not flagged; a cancelled mirror (A3) is
 *        drafted and flagged with the truthful NOT-eliminated confirm (round 17) (round 12: the generator never skips a manual row at all);
 *  B-M2  a reversal chain is walked once per row, so the cost of a period is linear in its depth (counted calls, not seconds);
 *  B-L1  a row whose own journal carries a reversal_of_id is still found from a reversal dated in the period (months add up to the year).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { createIntercompanyTransaction, matchIntercompanyTransactions } from '../../../src/modules/accounting/services/reports/intercompanyService';
import { autoGenerateEliminations, type FlaggedEliminationRow } from '../../../src/modules/accounting/services/reports/eliminationGenerator';
import { getEliminationAdjustments, postEliminationAdjustment } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { asService, co, groupAccounts as ga, inbox, sentInvoice, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
const { derived, approveBill, accepted } = L;
beforeAll(async () => { await L.setup(); await L.monthly(co.A, 2026); await L.monthly(co.B, 2026); }, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const redate = (bill: string, date: string) => pool.query('UPDATE supplier_invoices SET invoice_date = $2::date, due_date = $2::date + 30 WHERE id = $1', [bill, date]);
async function bookedOn(date: string) {
  const m = await accepted({ date });
  await redate(m.bill, date);
  await approveBill(m.bill);
  return m;
}
const manual = (from: string, to: string, type: string, amount = 1000) => asService(pool, U.ab, from, () => createIntercompanyTransaction({
  groupId: co.G, sourceCompanyId: from, targetCompanyId: to, transactionType: type, amount, transactionDate: '2026-01-15', description: `manual ${type}` }));
/** A manual P1 pair (A -> B of `type`, its counterpart B -> A), matched, then the generator over January. */
async function manualPair(type: string, back: string) {
  const r1 = await manual(co.A, co.B, type);
  const r2 = await manual(co.B, co.A, back);
  await asService(pool, U.ab, co.A, () => matchIntercompanyTransactions(r1.id, r2.id, co.G, U.ab));
  const flagged: FlaggedEliminationRow[] = [];
  const made = await asService(pool, U.ab, co.A, () => autoGenerateEliminations(co.G, '2026-01-01', '2026-01-31', flagged));
  return { made, flagged };
}
const net = (lines: Array<{ groupAccountId: string; debit: number; credit: number }>, id: string) =>
  lines.filter((l) => l.groupAccountId === id).reduce((n, l) => n + l.debit - l.credit, 0);

describe('B-M1: a rejected mirror or a loan never touches a manual elimination; a cancelled mirror flags it truthfully (never a skip)', () => {
  it('A1: the mirror REJECTED by B, then the sale captured as a manual P1 pair: eliminated, nothing skipped', async () => {
    const s = await sentInvoice(pool, { date: '2026-01-15' });
    expect((await inbox.reject(U.b, co.B, s.id, { reason: 'booked by hand' })).state.statusCode).toBe(200);
    expect(await derived('2026-01-01', '2026-01-31')).toHaveLength(0);
    const { made, flagged } = await manualPair('sale', 'purchase');
    expect(flagged).toEqual([]);
    expect(made.length).toBeGreaterThan(0);
    expect(net(made.flatMap((a) => a.lines), ga.rev)).toBeGreaterThan(0);   // the sale's revenue is eliminated
  });

  it('A2: a standing mirrored sale and a genuine intercompany LOAN of the same amount on the same date: the loan is eliminated', async () => {
    await bookedOn('2026-01-15');
    expect(await derived('2026-01-01', '2026-01-31')).toHaveLength(1);
    // the balance accounts a loan's elimination lands on: A's receivable and B's payable, mapped to group accounts
    const [gar, gap] = [crypto.randomUUID(), crypto.randomUUID()];
    await pool.query(`INSERT INTO group_accounts(id, group_id, account_code, account_name, account_type) VALUES ($1, $3, 'G-AR', 'Group AR', 'asset'), ($2, $3, 'G-AP', 'Group AP', 'liability')`, [gar, gap, co.G]);
    const acct = async (c: string, sub: string) => (await pool.query('SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = $2 LIMIT 1', [c, sub])).rows[0].id as string;
    await pool.query('INSERT INTO group_coa_mappings(group_id, group_account_id, company_id, company_account_id) VALUES ($1, $2, $3, $4), ($1, $5, $6, $7)',
      [co.G, gar, co.A, await acct(co.A, 'receivable'), gap, co.B, await acct(co.B, 'payable')]);
    try {
      const { made, flagged } = await manualPair('loan', 'loan');
      expect(flagged).toEqual([]);
      expect(made.map((a) => a.adjustmentType)).toContain('interco_balance');
    } finally {
      await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]);
      await pool.query('DELETE FROM group_coa_mappings WHERE group_account_id = ANY($1)', [[gar, gap]]);
      await pool.query('DELETE FROM group_accounts WHERE id = ANY($1)', [[gar, gap]]);
    }
  });

  it('A3: a mirrored invoice A CANCELLED, then a separate sale of the same amount the same day captured by hand: drafted, flagged with that mirror, and its confirm says the mirror is NOT eliminated', async () => {
    const m = await bookedOn('2026-01-15');
    await L.cancelSender(m.inv.id);
    expect(await derived('2026-01-01', '2026-01-31')).toHaveLength(0);
    const { made, flagged } = await manualPair('sale', 'purchase');
    // round 17 (R16 breaker H1): a cancelled mirror stays a candidate, judged as at the period, never by today's cancel stamp; so the draft
    // is flagged with it, and its confirm says the mirror is NOT eliminated automatically (the sale's own elimination is this draft)
    const ref = (await pool.query('SELECT description FROM intercompany_transactions WHERE id = $1', [m.message.group_transaction_id])).rows[0].description as string;
    expect(made.length).toBe(1);   // (the matched pair is one elimination)
    expect(flagged.map((f) => [f.adjustmentId, f.mirroredRef])).toEqual([[made[0]!.id, ref]]);
    expect(flagged[0]!.reason).toBe(`possibly the same sale as mirrored document ${ref} (the same companies and direction, and its amount and date), which is NOT eliminated automatically for the period to 2026-01-31: this may be the sale's only elimination`);
    const sale = made.find((a) => flagged[0]!.adjustmentId === a.id)!;
    const listed = (await asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, '2026-01-01', '2026-01-31'))).find((a) => a.id === sale.id)!;
    expect([listed.mirroredDuplicateOf, listed.mirrorStands]).toEqual([ref, false]);
    const refused = await asService(pool, U.ab, co.A, () => postEliminationAdjustment(sale.id, co.G)).then(() => 'posted', (e: Error) => e.message);
    expect(refused).toMatch(/which is NOT eliminated automatically at the moment .*: this may be the sale's only elimination/);
  });

});

describe('B-L1: a row whose own journal carries a reversal_of_id', () => {
  it('the sender journal planted with an up-link, reversed in March: March has the counter-elimination; the months add up to the year', async () => {
    const m = await bookedOn('2026-01-15');
    const j = m.message.source_journal_entry_id as string;
    const other = (await pool.query(`INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id)
      SELECT '2025-12-01', 'unrelated', 'manual', 'posted', created_by, company_id FROM gl_journal_entries WHERE id = $1 RETURNING id`, [j])).rows[0].id as string;
    await pool.query('UPDATE gl_journal_entries SET reversal_of_id = $2 WHERE id = $1', [j, other]);   // (a planted link: 1018 refuses it)
    const r = (await pool.query(`INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id)
      SELECT '2026-03-10', 'rev', source, 'draft', created_by, company_id FROM gl_journal_entries WHERE id = $1 RETURNING id`, [j])).rows[0].id as string;
    await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description)
      SELECT $2, gl_account_id, credit, debit, company_id, 'rev' FROM gl_journal_lines WHERE journal_entry_id = $1`, [j, r]);
    await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [r]);
    await pool.query('UPDATE gl_journal_entries SET reversal_of_id = $2 WHERE id = $1', [r, j]);
    const lines = async (f: string, t: string) => (await derived(f, t)).flatMap((e) => e.lines);
    expect(net(await lines('2026-03-01', '2026-03-31'), ga.rev)).toBe(-1000);
    let sum = 0;
    for (let i = 1; i <= 12; i++) {
      const f = `2026-${String(i).padStart(2, '0')}-01`;
      sum += net(await lines(f, new Date(Date.UTC(2026, i, 0)).toISOString().slice(0, 10)), ga.rev);
    }
    expect(sum).toBe(net(await lines('2026-01-01', '2026-12-31'), ga.rev));
  });
});

describe('B-M2: the cost of a period is linear in the chain\'s depth', () => {
  it('the sender journal reversed 300 times, a day apart: a year call checks each link once per chain walk, not once per date', async () => {
    const m = await bookedOn('2026-01-02');
    const j = m.message.source_journal_entry_id as string;
    const c = await pool.connect();
    try {
      await c.query('SET session_replication_role = replica');   // (the fixture's 1200 writes: only the chain's shape is under test)
      await c.query(`DO $$ DECLARE prev uuid := '${j}'; nxt uuid; BEGIN
        FOR i IN 1..300 LOOP
          INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id)
            SELECT '2026-01-03'::date + i, 'chain', source, 'draft', created_by, company_id FROM gl_journal_entries WHERE id = prev RETURNING id INTO nxt;
          INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description)
            SELECT nxt, gl_account_id, credit, debit, company_id, 'chain' FROM gl_journal_lines WHERE journal_entry_id = prev;
          UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = nxt;
          UPDATE gl_journal_entries SET reversal_of_id = prev WHERE id = nxt;
          prev := nxt;
        END LOOP; END $$`);
      await c.query('RESET session_replication_role');
      await c.query("SET track_functions = 'all'");
      const calls = async () => {
        await c.query('SELECT pg_stat_force_next_flush()');
        await c.query('SELECT pg_stat_clear_snapshot()');
        return Number((await c.query("SELECT COALESCE(sum(calls), 0) AS n FROM pg_stat_user_functions WHERE funcname = 'intercompany_lines_negate'")).rows[0].n);
      };
      const before = await calls();
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U.ab })]);
      await c.query('SELECT count(*) FROM public.intercompany_mirror_eliminations($1, $2, $3)', [co.G, '2026-01-01', '2026-12-31']);
      await c.query('COMMIT');
      const used = (await calls()) - before;
      // one walk of the 300-link chain checks 300 links (plus a handful for the other chains); a walk per date would be ~300 x 300
      expect(used).toBeGreaterThanOrEqual(300);
      expect(used).toBeLessThan(1000);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.query('RESET track_functions').catch(() => undefined);
      await c.query('RESET session_replication_role').catch(() => undefined);
      c.release();
    }
  }, 120000);
});
