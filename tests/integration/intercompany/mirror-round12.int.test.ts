/**
 * Intercompany P2, round 12: the generator NEVER skips a manual (P1) row because of a mirrored document. It drafts the elimination as always
 * and, when the row may be the same sale as a live mirrored document, marks the draft CHECK BEFORE POSTING and reports it (only what THIS
 * run drafted). The eliminations list warns on a POSTED manual adjustment whose row now matches a live mirror. The match is narrow: same
 * direction, sale types, the same signed amount and date, the mirror accepted and not withdrawn.
 *  N-M1  the receiver books the mirrored sale in the next month: the January draft is flagged, never silently skipped or doubled;
 *  N-M2  the mirror accepted after the manual elimination was posted: the list warns on the posted one;
 *  N-M3  a rejected mirror and a manual row naming its invoice journal: drafted, not flagged;
 *  N-L2  a credit (negative) manual row never matches a sale;
 *  N-M4  the generator walks no ledger chain for the flag;
 *  N-L1  a planted cycle back to the walk's start ends the chain walk.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { createIntercompanyTransaction, matchIntercompanyTransactions } from '../../../src/modules/accounting/services/reports/intercompanyService';
import { autoGenerateEliminations, type FlaggedEliminationRow } from '../../../src/modules/accounting/services/reports/eliminationGenerator';
import { getEliminationAdjustments } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { asService, co, inbox, sentInvoice, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
const { approveBill, accepted } = L;
beforeAll(async () => { await L.setup(); await L.monthly(co.A, 2026); await L.monthly(co.B, 2026); }, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const redate = (bill: string, date: string) => pool.query('UPDATE supplier_invoices SET invoice_date = $2::date, due_date = $2::date + 30 WHERE id = $1', [bill, date]);
const manual = (from: string, to: string, type: string, amount = 1000, journal?: string) => asService(pool, U.ab, from, () => createIntercompanyTransaction({
  groupId: co.G, sourceCompanyId: from, targetCompanyId: to, transactionType: type, amount, transactionDate: '2026-01-15', description: `manual ${type}`,
  ...(journal ? { sourceJournalEntryId: journal } : {}) }));
async function pair(journal?: string) {
  const r1 = await manual(co.A, co.B, 'sale', 1000, journal);
  const r2 = await manual(co.B, co.A, 'purchase');
  await asService(pool, U.ab, co.A, () => matchIntercompanyTransactions(r1.id, r2.id, co.G, U.ab));
  return { r1, r2 };
}
async function generate(from = '2026-01-01', to = '2026-01-31') {
  const flagged: FlaggedEliminationRow[] = [];
  const made = await asService(pool, U.ab, co.A, () => autoGenerateEliminations(co.G, from, to, flagged));
  return { made, flagged };
}
const postAll = () => pool.query("UPDATE consolidation_adjustments SET status = 'posted', posted_at = now() WHERE group_id = $1", [co.G]);

describe('drafted and flagged, never skipped', () => {
  it('N-M1: a sale on 15 Jan the receiver books on 5 Feb, and a manual pair: the January run DRAFTS the A->B row flagged; a second run reports nothing new', async () => {
    const m = await accepted({ date: '2026-01-15' });
    await redate(m.bill, '2026-02-05');
    await approveBill(m.bill);
    const { r1 } = await pair();
    const first = await generate();
    const own = first.made.find((a) => a.sourceIntercompanyId === r1.id)!;
    expect(own.status).toBe('draft');
    expect(own.description).toMatch(/CHECK BEFORE POSTING: possibly the same sale as mirrored document .*Invoice/);
    expect(first.flagged.map((f) => [f.transactionId, f.adjustmentId])).toEqual([[r1.id, own.id]]);   // (B -> A runs the other way: no flag)
    const again = await generate('2026-01-01', '2026-12-31');
    expect(again.flagged).toEqual([]);   // nothing drafted this run, nothing reported
  });

  it('N-M2: the mirror accepted AFTER the manual elimination was posted: the list warns on the posted adjustment', async () => {
    const s = await sentInvoice(pool, { date: '2026-01-15' });   // pending: no flag at generation
    const { r1 } = await pair();
    const first = await generate();
    expect(first.flagged).toEqual([]);
    await postAll();
    expect((await inbox.accept(U.b, co.B, s.id)).state.statusCode).toBe(200);
    const bill = (await pool.query('SELECT target_doc_id FROM intercompany_messages WHERE id = $1', [s.id])).rows[0].target_doc_id as string;
    await redate(bill, '2026-01-15');
    await approveBill(bill);
    const list = await asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, '2026-01-01', '2026-01-31'));
    const posted = list.find((a) => a.sourceIntercompanyId === r1.id)!;
    expect(posted.mirroredDuplicateOf).toMatch(/Invoice/);
    expect(list.filter((a) => a.automatic)).toHaveLength(1);   // the derived one, beside it
  });

  it('N-M3: a REJECTED mirror and a manual row naming its invoice journal: drafted, not flagged', async () => {
    const s = await sentInvoice(pool, { date: '2026-01-15' });
    expect((await inbox.reject(U.b, co.B, s.id, { reason: 'by hand' })).state.statusCode).toBe(200);
    const { r1 } = await pair(s.message.source_journal_entry_id as string);
    const { made, flagged } = await generate();
    expect(flagged).toEqual([]);
    expect(made.find((a) => a.sourceIntercompanyId === r1.id)?.description).not.toMatch(/CHECK BEFORE POSTING/);
  });

  it('N-L2: a CREDIT manual row (negative) on the mirrored sale\'s date never matches the sale', async () => {
    const m = await accepted({ date: '2026-01-15' });
    await redate(m.bill, '2026-01-15');
    await approveBill(m.bill);
    const r = await manual(co.A, co.B, 'sale', -1000);
    await pool.query("UPDATE intercompany_transactions SET match_status = 'matched' WHERE id = $1", [r.id]);
    const { flagged } = await generate();
    expect(flagged).toEqual([]);
  });

  it('direction: B\'s own sale to A of the same amount on the same day is not the mirrored A -> B sale: drafted, not flagged', async () => {
    const m = await accepted({ date: '2026-01-15' });
    await redate(m.bill, '2026-01-15');
    await approveBill(m.bill);
    const r = await manual(co.B, co.A, 'sale');
    await pool.query("UPDATE intercompany_transactions SET match_status = 'matched' WHERE id = $1", [r.id]);
    const { flagged } = await generate();
    expect(flagged).toEqual([]);
  });

  it('N-M4: the generator walks no ledger chain for the flag (no pair or chain function is called)', async () => {
    const m = await accepted({ date: '2026-01-15' });
    await redate(m.bill, '2026-01-15');
    await approveBill(m.bill);
    await pair();
    const c = await pool.connect();
    try {
      await c.query("SET track_functions = 'all'");
      const calls = async () => {
        await c.query('SELECT pg_stat_force_next_flush()');
        await c.query('SELECT pg_stat_clear_snapshot()');
        return Number((await c.query(`SELECT COALESCE(sum(calls), 0) AS n FROM pg_stat_user_functions
                                      WHERE funcname IN ('intercompany_mirror_pair_at', 'intercompany_journal_chain_eff')`)).rows[0].n);
      };
      const before = await calls();
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U.ab })]);
      const n = (await c.query(`SELECT count(*)::int AS n FROM intercompany_transactions ict
                                 CROSS JOIN LATERAL public.intercompany_mirrored_duplicate(ict.id) d WHERE ict.group_id = $1`, [co.G])).rows[0].n;
      await c.query('COMMIT');
      expect(n).toBe(1);
      expect((await calls()) - before).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.query('RESET track_functions').catch(() => undefined);
      c.release();
    }
  });
});

describe('N-L1: the chain walk ends on a planted cycle', () => {
  it('a journal whose own reversal_of_id points at its reversal: the walk from it counts two journals and stops', async () => {
    const m = await accepted({ date: '2026-01-15' });
    const j = m.message.source_journal_entry_id as string;
    const r = (await pool.query(`INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id)
      SELECT entry_date, 'rev', source, 'draft', created_by, company_id FROM gl_journal_entries WHERE id = $1 RETURNING id`, [j])).rows[0].id as string;
    await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description)
      SELECT $2, gl_account_id, credit, debit, company_id, 'rev' FROM gl_journal_lines WHERE journal_entry_id = $1`, [j, r]);
    await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [r]);
    await pool.query('UPDATE gl_journal_entries SET reversal_of_id = $2 WHERE id = $1', [r, j]);
    await pool.query('UPDATE gl_journal_entries SET reversal_of_id = $2 WHERE id = $1', [j, r]);   // (a planted cycle: 1018 refuses it)
    const c = await pool.connect();
    try {
      await c.query("SET statement_timeout = '10s'");
      const eff = (await c.query('SELECT cardinality(public.intercompany_journal_chain_eff($1, $2)) AS n', [j, co.A])).rows[0].n;
      expect(Number(eff)).toBe(2);
    } finally {
      await c.query('RESET statement_timeout').catch(() => undefined);
      c.release();
    }
  });
});
