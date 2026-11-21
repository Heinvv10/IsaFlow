/**
 * Intercompany P2, round 10 (the round-9 breaker review):
 *  B-L1  (superseded in round 12: the generator never skips a manual row; it drafts and flags it, see mirror-round12)
 *  B-L2  a session with no signed-in user (the service login) cannot name a target journal on a new row (the claimed-journal check answers
 *        only for a user's groups);
 *  S10   a reversal chain is walked to its end, however deep (a capped walk would return a truncated count, a parity that fails open);
 *  B-L3  the derivation's chain work follows the period's rows (a row with no journal dated in the period is never walked), and the
 *        cumulative windows derive only when a derived line can land on a balance-sheet line.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { autoGenerateEliminations, type FlaggedEliminationRow } from '../../../src/modules/accounting/services/reports/eliminationGenerator';
import { getConsolidatedBalanceSheet } from '../../../src/modules/accounting/services/reports/consolidatedStatementsService';
import { asService, co, groupAccounts as ga, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';
import { asDefiner, outcome } from './intercompany.helpers';

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

describe('B-L1 (round 12: never a skip): a manual row of another sale is eliminated and not flagged', () => {
  it('a manual matched row of another sale (different amount) is eliminated, with no flag', async () => {
    await bookedOn('2026-01-15');
    await asDefiner(pool, U.ab, co.A, (q) => q.query(
      `INSERT INTO intercompany_transactions(group_id, source_company_id, target_company_id, transaction_type, amount, currency, description, transaction_date, match_status)
       VALUES ($1, $2, $3, 'sale', 70, 'ZAR', 'another sale', '2026-01-15', 'matched')`, [co.G, co.A, co.B]), true);
    const flagged: FlaggedEliminationRow[] = [];
    expect(await asService(pool, U.ab, co.A, () => autoGenerateEliminations(co.G, '2026-01-01', '2026-01-31', flagged))).toHaveLength(1);
    expect(flagged).toEqual([]);
  });
});

describe('B-L2: the service login cannot name a target journal', () => {
  it('app_service with no claims: a row naming B\'s bound journal is refused; one naming none is not', async () => {
    await bookedOn('2026-01-15');
    const j = (await L.groupRow()).target_journal_entry_id as string;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_service');
      const row = (target: string | null) => outcome(c,
        `INSERT INTO intercompany_transactions(group_id, source_company_id, target_company_id, transaction_type, amount, currency, transaction_date, description, target_journal_entry_id)
         VALUES ($1, $2, $3, 'management_fee', 1, 'ZAR', '2026-01-20', 'service', $4)`, [co.G, co.A, co.B, target]);
      expect(await row(j)).toMatch(/^23514: intercompany_transactions: a transaction naming a target journal is written by a signed-in user/);
      expect(await row(null)).toBe('ok');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

describe('B-L3: the chain work follows the period', () => {
  it('three rows booked in September and one in October: the October derivation walks the chains of the October row only', async () => {
    for (const d of ['2026-09-03', '2026-09-10', '2026-09-17']) await bookedOn(d);
    await bookedOn('2026-10-05');
    const c = await pool.connect();
    try {
      await c.query("SET track_functions = 'all'");
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U.ab })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [co.A]);
      const calls = async () => {
        await c.query('SELECT pg_stat_force_next_flush()');
        await c.query('SELECT pg_stat_clear_snapshot()');
        return Number((await c.query("SELECT COALESCE(sum(calls), 0) AS n FROM pg_stat_user_functions WHERE funcname = 'intercompany_journal_chain_eff'")).rows[0].n);
      };
      const a = await calls();
      const n = (await c.query('SELECT count(*)::int AS n FROM public.intercompany_mirror_eliminations($1, $2, $3)', [co.G, '2026-10-01', '2026-10-31'])).rows[0].n;
      await c.query('COMMIT');   // (the function counts are flushed with the transaction)
      const b = await calls();
      expect(n).toBe(2);              // the October row's two lines
      expect(b - a).toBeGreaterThan(0);
      expect(b - a).toBeLessThanOrEqual(3);   // at most its three chains (sender, first match, bill), none of the three September rows' nine
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.query('RESET track_functions').catch(() => undefined);
      c.release();
    }
    expect(await derived('2026-09-01', '2026-09-30')).toHaveLength(3);
  });

  it('the balance sheet reads the derived lines only when one can land on a balance-sheet line: a revenue account mapped to an equity group account', async () => {
    await bookedOn('2026-01-15');
    const bs = () => asService(pool, U.ab, co.A, () => getConsolidatedBalanceSheet(co.G, '2026-12-31'));
    const eq = crypto.randomUUID();
    await pool.query(`INSERT INTO group_accounts(id, group_id, account_code, account_name, account_type) VALUES ($1, $2, 'G-EQ', 'Group odd equity', 'equity')`, [eq, co.G]);
    const aRev = (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'default_revenue'", [co.A])).rows[0].id as string;
    const aAr = (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'receivable'", [co.A])).rows[0].id as string;
    await pool.query('UPDATE group_coa_mappings SET group_account_id = $3 WHERE group_id = $1 AND company_account_id = $2', [co.G, aRev, eq]);
    // (a balance sheet line exists only for a group account a company balance-sheet account with a balance maps to)
    await pool.query('INSERT INTO group_coa_mappings(group_id, group_account_id, company_id, company_account_id) VALUES ($1, $2, $3, $4)', [co.G, eq, co.A, aAr]);
    try {
      const line = (await bs()).equity.find((l) => l.groupAccountId === eq);
      expect(Math.abs(line?.eliminationAmount ?? 0)).toBe(1000);   // the derived revenue debit on the (odd) equity account is applied
    } finally {
      await pool.query('DELETE FROM group_coa_mappings WHERE group_id = $1 AND company_account_id = $2', [co.G, aAr]);
      await pool.query('UPDATE group_coa_mappings SET group_account_id = $3 WHERE group_id = $1 AND company_account_id = $2', [co.G, aRev, ga.rev]);
      await pool.query('DELETE FROM group_accounts WHERE id = $1', [eq]);
    }
  });
});

describe('S10: a reversal chain past any depth cap is counted to its end', () => {
  it('the sender\'s journal reversed 1001 times (an even chain of 1002): its parity is even and nothing is eliminated', async () => {
    const m = await bookedOn('2026-01-15');
    const j = m.message.source_journal_entry_id as string;
    expect(await derived()).toHaveLength(1);
    // a fixture's chain: each journal the exact negation of the one before, linked once posted (no service, no hook; the ordinary ledger
    // triggers are skipped for the 4004 fixture writes, replica mode, as only the chain's shape is under test)
    const c = await pool.connect();
    try {
      await c.query("SET session_replication_role = replica");
      await c.query(`DO $$
      DECLARE prev uuid := '${j}'; nxt uuid;
      BEGIN
        FOR i IN 1..1001 LOOP
          INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id)
            SELECT entry_date, 'deep chain', 'manual', 'draft', created_by, company_id FROM gl_journal_entries WHERE id = prev RETURNING id INTO nxt;
          INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description)
            SELECT nxt, gl_account_id, credit, debit, company_id, 'deep chain' FROM gl_journal_lines WHERE journal_entry_id = prev;
          UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = nxt;
          UPDATE gl_journal_entries SET reversal_of_id = prev WHERE id = nxt;
          prev := nxt;
        END LOOP;
      END $$`);
    } finally {
      await c.query('RESET session_replication_role');
      c.release();
    }
    expect(Number((await pool.query('SELECT public.intercompany_journal_chain_length($1, $2) AS n', [j, co.A])).rows[0].n)).toBe(1002);
    expect(await derived()).toHaveLength(0);
  }, 300000);
});
