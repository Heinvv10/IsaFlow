/**
 * Intercompany P2, round 8 guards (the round-7 reviews):
 *  B-M4  one receiver journal is never claimed by two rows: the unique index on first_target_journal_entry_id refuses a concurrent second
 *        match (two bills pointed at one journal in two transactions, as app_user), and intercompany_receiver_je's first-match path refuses a
 *        journal another row holds;
 *  B-L1  the period key is the sender JOURNAL's own date, not the group row's;
 *  B-L2  the value checks and the elimination lines read the same lines (each journal's own company's);
 *  Q-M2  createEliminationAdjustment's savepoint + 23505 mapping: a second standing elimination of a row is EliminationAlreadyStandsError and
 *        the request transaction is still usable;
 *  Q-L1  the generator refuses to run outside a transaction (its advisory lock would serialise nothing).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { autoGenerateEliminations, createEliminationAdjustment } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { EliminationAlreadyStandsError } from '../../../src/modules/accounting/services/reports/eliminationErrors';
import { acc, asService, co, groupAccounts as ga, inbox, plantArInvoice, U } from './mirror.helpers';
import { lockWaiter, makeLedger } from './ledger.helpers';
import { asAppUser, withoutTrigger } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
const L = makeLedger(pool);
const { derived, approveBill, accepted, rows } = L;
beforeAll(L.setup, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const acct = async (company: string, where: string) => (await pool.query(`SELECT id FROM gl_accounts WHERE company_id = $1 AND ${where} LIMIT 1`, [company])).rows[0].id as string;
const net = async (from?: string, to?: string) => {
  const all = (await derived(from, to)).flatMap((e) => e.lines);
  const sum = (id: string) => all.filter((l) => l.groupAccountId === id).reduce((n, l) => n + l.debit - l.credit, 0);
  return { rev: sum(ga.rev), exp: sum(ga.exp) };
};
/** An open app_user session as withAuth opens one (BEGIN, the role, the claims); the caller commits or rolls back. */
async function session(user: string, company: string): Promise<PoolClient> {
  const c = await pool.connect();
  await c.query('BEGIN');
  await c.query('SET LOCAL ROLE app_user');
  await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
  await c.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
  return c;
}

describe('B-M4: one receiver journal, one row', () => {
  it('two bills pointed at ONE journal in two concurrent app_user transactions: the second waits and loses; one elimination, not two', async () => {
    const [m1, m2] = [await accepted(), await accepted()];   // two R1 000 + R150 invoices; B's two draft bills
    const num = (await pool.query('SELECT invoice_number FROM supplier_invoices WHERE id = $1', [m1.bill])).rows[0].invoice_number as string;
    await pool.query("UPDATE supplier_invoices SET invoice_number = $2, external_ref = 'dup' WHERE id = $1", [m2.bill, num]);   // so J carries both bills' text
    const [exp, vat, ap] = [acc.bExp1, await acct(co.B, "account_subtype = 'vat_input'"), await acct(co.B, "account_subtype = 'payable'")];
    const j = (await pool.query(
      `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id) VALUES ('2026-09-01', $1, 'auto_supplier_invoice', 'draft', $2, $3) RETURNING id`,
      [`Supplier invoice ${num}`, U.b, co.B])).rows[0].id as string;
    await pool.query('INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, 1000, 0, $5), ($1, $3, 150, 0, $5), ($1, $4, 0, 1150, $5)', [j, exp, vat, ap, co.B]);
    await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [j]);
    const claim = async (c: PoolClient, bill: string) => {
      await c.query("UPDATE supplier_invoices SET status = 'approved', gl_journal_entry_id = $2 WHERE id = $1", [bill, j]);
      return (await c.query("SELECT public.intercompany_sync_group_row('supplier_invoice', $1) AS s", [bill])).rows[0].s as string;
    };
    const [c1, c2] = [await session(U.b, co.B), await session(U.b, co.B)];
    try {
      expect(await claim(c1, m1.bill)).toBe('matched');
      const pid2 = Number((await c2.query('SELECT pg_backend_pid() AS p')).rows[0].p);
      const second = claim(c2, m2.bill).then((s) => ({ s, err: null as string | null }), (e: Error) => ({ s: null, err: e.message }));
      const waited = await lockWaiter(pool, null, 5000, pid2);   // the SECOND transaction's write waits on the first's uncommitted claim of J
      await c1.query('COMMIT');
      const out = await second;
      if (out.err === null) await c2.query('COMMIT'); else await c2.query('ROLLBACK');
      expect(waited, 'the second transaction waited on the first').toBe(true);
      // without 1018: the second's sync loses on uq_ic_transactions_first_journal and is mapped to a variance; with 1018 the second bill's link to
      // a journal another document holds is refused before the sync runs. Either way J is the first row's alone.
      process.stderr.write(`[round8 B-M4] second claim: ${out.err === null ? `sync answered ${out.s}` : `refused: ${out.err}`}\n`);
      if (out.err === null) expect(out.s).toBe('variance');
      else expect(out.err).toMatch(/already belongs to another document/);
    } finally { c1.release(); c2.release(); }
    const byId = new Map((await rows()).map((r) => [r.id as string, r]));
    expect(byId.get(m1.message.payload.groupTransactionId)).toMatchObject({ match_status: 'matched', first_target_journal_entry_id: j });
    expect(byId.get(m2.message.payload.groupTransactionId)!.first_target_journal_entry_id).toBeNull();
    expect((await derived()).map((e) => e.transactionId)).toEqual([m1.message.payload.groupTransactionId]);
    expect(await net()).toEqual({ rev: 1000, exp: -1000 });
  }, 60000);

  it('the first-match path refuses a journal another MIRRORED row holds as its target (the database binds those): it eliminates nothing', async () => {
    const m1 = await accepted();
    await approveBill(m1.bill);
    const m2 = await accepted();
    const j = (await L.groupRow()).first_target_journal_entry_id as string;
    expect(await derived()).toHaveLength(1);
    await withoutTrigger(pool, 'intercompany_transactions', 'trg_intercompany_transaction_parties_immutable', (q) => q.query(
      'UPDATE intercompany_transactions SET target_journal_entry_id = $2 WHERE id = $1', [m2.message.payload.groupTransactionId, j]));
    expect(await derived()).toHaveLength(0);
  });
});

describe('B-L1: the period key is the sender journal\'s own date', () => {
  it('the sender\'s journal dated 5 Oct for an invoice (and group row) dated 1 Sep, booked by B on 1 Sep: Sep 0, Oct 1 keyed 5 Oct', async () => {
    // the invoice dated 1 Sep with its approval journal dated 5 Oct (created so, never re-dated: 1018 freezes a posted journal's date), sent by
    // the database and accepted by B
    const inv = await plantArInvoice(pool, { status: 'approved', journalDate: '2026-10-05' });
    const sent = await asAppUser(pool, U.a, co.A, async (q) => (await q.query("SELECT * FROM public.intercompany_send_for_source('customer_invoice', $1)", [inv.id])).rows[0], true);
    expect(sent).toMatchObject({ reason: null });
    expect((await inbox.accept(U.b, co.B, sent.message_id)).state.statusCode).toBe(200);
    const bill = (await pool.query('SELECT target_doc_id FROM intercompany_messages WHERE id = $1', [sent.message_id])).rows[0].target_doc_id as string;
    await approveBill(bill);
    expect(await derived('2026-09-01', '2026-09-30')).toHaveLength(0);
    expect((await derived('2026-10-01', '2026-10-31')).map((e) => e.keyDate)).toEqual(['2026-10-05']);
  });
});

describe('B-L2: the value checks and the elimination read the same lines', () => {
  it('lines carrying the OTHER company\'s id on either journal are read by neither the value checks nor the elimination', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const rje = (await L.groupRow()).first_target_journal_entry_id as string;
    const foreign = (je: string, company: string, lines: Array<[string, number, number]>) => Promise.all(lines.map(([a, d, c]) => pool.query(
      'INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, $3, $4, $5)', [je, a, d, c, company])));
    // a line's account is its own company's (gl_journal_lines_account_company_fk), so each foreign line is on an account of the OTHER company
    const own = async (company: string, type: string) => (await pool.query(
      `INSERT INTO gl_accounts(company_id, account_code, account_name, account_type, normal_balance, is_active)
       VALUES ($1, $2, $2, $3, $4, true) RETURNING id`, [company, `ICL2${type.slice(0, 3)}${crypto.randomUUID().slice(0, 6)}`, type, type === 'revenue' ? 'credit' : 'debit'])).rows[0].id as string;
    // the sender's journal: R50 more revenue on a line of B's; the receiver's: R50 more expense on a line of A's (each balanced on its line company)
    await foreign(m.message.source_journal_entry_id, co.B, [[await own(co.B, 'revenue'), 0, 50], [await own(co.B, 'asset'), 50, 0]]);
    await foreign(rje, co.A, [[await own(co.A, 'expense'), 50, 0], [await own(co.A, 'liability'), 0, 50]]);
    expect(await net()).toEqual({ rev: 1000, exp: -1000 });
  });
});

describe('Q-M2 and Q-L1: the stored adjustment\'s guards', () => {
  const manualRow = async () => {
    await pool.query(
      `INSERT INTO intercompany_transactions(group_id, source_company_id, target_company_id, transaction_type, amount, currency, description, transaction_date)
       VALUES ($1, $2, $3, 'sale', 70, 'ZAR', 'manual row', '2026-09-01')`, [co.G, co.A, co.B]);
    return (await pool.query("SELECT id FROM intercompany_transactions WHERE group_id = $1 AND description = 'manual row'", [co.G])).rows[0].id as string;
  };
  const input = (row: string) => ({ adjustmentType: 'interco_revenue', description: 'manual', periodStart: '2026-01-01', periodEnd: '2026-12-31', sourceIntercompanyId: row,
    lines: [{ groupAccountId: ga.rev, debit: 70, credit: 0, description: 'r' }, { groupAccountId: ga.exp, debit: 0, credit: 70, description: 'e' }] });

  it('a second elimination of one row (the index present) is EliminationAlreadyStandsError, and the request transaction carries on', async () => {
    expect((await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'uq_consolidation_adjustments_standing_source'")).rowCount).toBe(1);
    const row = await manualRow();
    const after = await asService(pool, U.ab, co.A, async (q) => {
      await createEliminationAdjustment(co.G, input(row));
      const second = await createEliminationAdjustment(co.G, input(row)).then(() => null, (e: unknown) => e);
      expect(second).toBeInstanceOf(EliminationAlreadyStandsError);
      return Number((await q.query('SELECT count(*)::int AS n FROM consolidation_adjustments WHERE group_id = $1', [co.G])).rows[0].n);   // the tx is usable
    });
    expect(after).toBe(1);
    expect(await L.adjustments()).toHaveLength(1);   // and it committed
  });

  it('the generator outside a transaction is refused (the advisory lock would be released at once)', async () => {
    await expect(autoGenerateEliminations(co.G, '2026-01-01', '2026-12-31')).rejects.toThrow(/must run inside a transaction/);
    expect(await asService(pool, U.ab, co.A, () => autoGenerateEliminations(co.G, '2026-01-01', '2026-12-31'))).toEqual([]);
  });
});
