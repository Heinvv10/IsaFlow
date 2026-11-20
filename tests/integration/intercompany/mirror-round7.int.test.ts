/**
 * Intercompany P2, round 7 (the round-6 review of the derived eliminations):
 *  R1  the period key is the LATER of the sender's document date and the receiver's journal date, so months add up to the range (B1, B2);
 *  B4  the elimination lines are the journals' OWN accounts mapped to their group accounts (never the lowest-coded mapped account of a type),
 *      and the income statement carries both sides even when one group account had no activity;
 *  B3  a STORED elimination of a mirrored row (an older generator's, e.g. after a code rollback) is never counted or listed;
 *  L2  a person cannot accept a message whose sender document is out of its books, though no hook stamped the message;
 *      and an approve-time sync that never ran still eliminates (the receiver's journal is found from the accepted message's bill).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { getPostedEliminations } from '../../../src/modules/accounting/services/reports/consolidatedTrialBalanceService';
import { getEliminationAdjustments } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { getConsolidatedIncomeStatement } from '../../../src/modules/accounting/services/reports/consolidatedStatementsService';
import { acc, asService, co, errorOf, groupAccounts as ga, inbox, rawReverseJournal, sentInvoice, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';
import { withoutTrigger } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
const { derived, approveBill, accepted, unbind } = L;
beforeAll(async () => { await L.setup(); await L.monthly(co.B, 2026); }, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const redate = (bill: string, date: string) => pool.query('UPDATE supplier_invoices SET invoice_date = $2::date, due_date = $2::date + 30 WHERE id = $1', [bill, date]);
const count = async (from: string, to: string) => (await derived(from, to)).length;

describe('R1: the period key is the later of the two dates; months add up to the range', () => {
  it('B1: sold 30 Sep, booked by the receiver 2 Oct: Sep 0, Oct 1, Sep-Oct 1', async () => {
    const m = await accepted({ date: '2026-09-30' });
    await redate(m.bill, '2026-10-02');
    await approveBill(m.bill);
    expect([await count('2026-09-01', '2026-09-30'), await count('2026-10-01', '2026-10-31'), await count('2026-09-01', '2026-10-31')]).toEqual([0, 1, 1]);
    expect((await derived('2026-10-01', '2026-10-31'))[0]!.keyDate).toBe('2026-10-02');
  });

  it('B2: sold 1 Sep, booked by the receiver 28 Aug: Aug 0, Sep 1', async () => {
    const m = await accepted({ date: '2026-09-01' });
    await redate(m.bill, '2026-08-28');
    await approveBill(m.bill);
    expect([await count('2026-08-01', '2026-08-31'), await count('2026-09-01', '2026-09-30'), await count('2026-08-01', '2026-09-30')]).toEqual([0, 1, 1]);
  });
});

describe('B4: the journals\' own accounts, on the income statement both sides', () => {
  it('B\'s UNUSED expense account mapped to a group account that sorts first (G-AAA) is never chosen: the credit is on the bill\'s own account\'s group account', async () => {
    const aaa = crypto.randomUUID();
    await pool.query(`INSERT INTO group_accounts(id, group_id, account_code, account_name, account_type) VALUES ($1, $2, 'G-AAA', 'Group AAA', 'expense')`, [aaa, co.G]);
    await pool.query('INSERT INTO group_coa_mappings(group_id, group_account_id, company_id, company_account_id) VALUES ($1, $2, $3, $4)', [co.G, aaa, co.B, acc.bExp2]);
    try {
      const m = await accepted();
      await approveBill(m.bill);
      const lines = (await derived()).flatMap((e) => e.lines);
      expect(lines.map((l) => [l.groupAccountId, l.debit, l.credit])).toEqual([[ga.rev, 1000, 0], [ga.exp, 0, 1000]]);
      const is = await asService(pool, U.ab, co.A, () => getConsolidatedIncomeStatement(co.G, '2026-01-01', '2026-12-31'));
      const elim = (items: Array<{ groupAccountId: string; eliminationAmount: number }>, id: string) => items.find((i) => i.groupAccountId === id)?.eliminationAmount;
      expect(elim(is.revenue, ga.rev)).toBe(-1000);
      expect(elim([...is.operatingExpenses, ...is.costOfSales], ga.exp)).toBe(-1000);
      expect(elim([...is.operatingExpenses, ...is.costOfSales], aaa)).toBeUndefined();
    } finally {
      await pool.query('DELETE FROM group_coa_mappings WHERE group_account_id = $1', [aaa]);
      await pool.query('DELETE FROM group_accounts WHERE id = $1', [aaa]);
    }
  });
});

describe('B3: a stored elimination of a mirrored row is never counted or listed', () => {
  it('an older generator\'s posted adjustment for the mirrored row: the reports and the list show the derived one only', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const row = m.message.payload.groupTransactionId as string;
    await pool.query(
      `INSERT INTO consolidation_adjustments(group_id, adjustment_type, description, period_start, period_end, lines, source_intercompany_id, status)
       VALUES ($1, 'interco_revenue', 'old generator', '2026-01-01', '2026-12-31', $2::jsonb, $3, 'posted')`,
      [co.G, JSON.stringify([{ groupAccountId: ga.rev, debit: 1000, credit: 0, description: 'r' }, { groupAccountId: ga.exp, debit: 0, credit: 1000, description: 'e' }]), row]);
    const posted = await asService(pool, U.ab, co.A, () => getPostedEliminations(co.G, '2026-01-01', '2026-12-31'));
    expect(posted.filter((l) => l.groupAccountId === ga.rev).reduce((n, l) => n + l.debit - l.credit, 0)).toBe(1000); // not 2000
    const list = await asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, '2026-01-01', '2026-12-31'));
    expect(list.map((a) => a.automatic === true)).toEqual([true]);
  });
});

describe('L2 and the hook-free receiver journal', () => {
  it('the sender\'s document left its books with no hook (no stamp on the message): a person\'s accept is refused, nothing is drafted', async () => {
    const sent = await sentInvoice(pool);
    // the ledger only: a raw reversal (no service, so no hook stamps or withdraws the message)
    const je = (await pool.query('SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = $1', [sent.inv.id])).rows[0].je as string;
    await rawReverseJournal(pool, je);
    const msg = (await pool.query('SELECT status, source_cancelled_at FROM intercompany_messages WHERE id = $1', [sent.id])).rows[0];
    expect(msg).toMatchObject({ status: 'pending', source_cancelled_at: null });
    const res = await inbox.accept(U.b, co.B, sent.id);
    expect(res.state.statusCode).toBe(409);
    expect(errorOf(res)).toMatch(/cancelled this document/);
    expect((await pool.query('SELECT target_doc_id FROM intercompany_messages WHERE id = $1', [sent.id])).rows[0].target_doc_id).toBeNull();
  });

  it('the approve-time sync never bound the row (hook failed): the elimination is still derived from the accepted message\'s bill', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const before = await derived();
    await unbind();
    expect(await derived()).toEqual(before);
    expect(before).toHaveLength(1);
  });
});

describe('R2: the migration never changes existing consolidation data; without its index, two runs still make one adjustment', () => {
  const block = () => {
    const sqlText = readFileSync('scripts/migrations/sql/1019_intercompany_p2_mirror.sql', 'utf8');
    const start = sqlText.indexOf('DO $$\nDECLARE\n  v_dups integer;');
    return sqlText.slice(start, sqlText.indexOf('END $$;', start) + 'END $$;'.length);
  };
  const manualRow = async () => {
    await pool.query(
      `INSERT INTO intercompany_transactions(group_id, source_company_id, target_company_id, transaction_type, amount, currency, description, transaction_date)
       VALUES ($1, $2, $3, 'sale', 70, 'ZAR', 'manual row', '2026-09-01') RETURNING id`, [co.G, co.A, co.B]);
    await withoutTrigger(pool, 'intercompany_transactions', 'trg_intercompany_transaction_parties_immutable', (q) => q.query(
      "UPDATE intercompany_transactions SET match_status = 'matched' WHERE group_id = $1 AND description = 'manual row'", [co.G]));
    return (await pool.query("SELECT id FROM intercompany_transactions WHERE group_id = $1 AND description = 'manual row'", [co.G])).rows[0].id as string;
  };
  const indexExists = async () => (await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'uq_consolidation_adjustments_standing_source'")).rowCount === 1;

  it('with legacy duplicates the block leaves them untouched and builds no index; with none it builds the index', async () => {
    await pool.query('DROP INDEX IF EXISTS uq_consolidation_adjustments_standing_source');
    try {
      const row = await manualRow();
      for (const status of ['posted', 'draft']) {
        await pool.query(
          `INSERT INTO consolidation_adjustments(group_id, adjustment_type, description, period_start, period_end, lines, source_intercompany_id, status)
           VALUES ($1, 'interco_revenue', 'legacy', '2026-01-01', '2026-12-31', '[]'::jsonb, $2, $3)`, [co.G, row, status]);
      }
      await pool.query(block());
      expect(await indexExists()).toBe(false);
      expect((await pool.query('SELECT status FROM consolidation_adjustments WHERE group_id = $1 ORDER BY status', [co.G])).rows.map((r) => r.status)).toEqual(['draft', 'posted']);
      await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]);
      await pool.query(block());
      expect(await indexExists()).toBe(true);
    } finally {
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_consolidation_adjustments_standing_source ON consolidation_adjustments (source_intercompany_id)
                        WHERE status IN ('draft', 'posted')`);
    }
  });

  it('no index: two generator runs at once still make ONE adjustment (the per-group advisory lock serialises them)', async () => {
    await pool.query('DROP INDEX IF EXISTS uq_consolidation_adjustments_standing_source');
    try {
      await manualRow();
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      let written!: () => void;
      const wrote = new Promise<void>((r) => { written = r; });
      const first = asService(pool, U.ab, co.A, async () => { const out = await L.eliminate(); written(); await held; return out; });
      await wrote;
      const second = asService(pool, U.ab, co.A, () => L.eliminate());
      await new Promise((r) => setTimeout(r, 500));
      release();
      const [a, b] = await Promise.all([first, second]);
      expect([a.length, b.length]).toEqual([1, 0]);
      expect(await L.adjustments()).toHaveLength(1);
    } finally {
      await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_consolidation_adjustments_standing_source ON consolidation_adjustments (source_intercompany_id)
                        WHERE status IN ('draft', 'posted')`);
    }
  });
});
