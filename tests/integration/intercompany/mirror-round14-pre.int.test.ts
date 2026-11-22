/**
 * Intercompany P2, round 14: BEFORE a pair's cutover (the pair here never has both sides on) a manual row can still be the same sale as a
 * mirror, so the flag stays, and the round-13 breaker's holes are closed:
 *  R13-M1  whether the mirror is eliminated automatically is judged at the later of its two document dates (a bill booked in a later month),
 *          with the confirm and without it (posted while the mirror was pending);
 *  R13-M2  drafts are judged too, and the 409 says what is true for a cut-off sale (NOT eliminated automatically);
 *  R13-M3  a row equal to the SUM of the month's mirrors (three invoices; an invoice net of its credit note) is flagged;
 *  R13-M4  the pair's purchase row (B -> A, matched with the sale) is flagged, and refused at posting without a confirm;
 *  R13-L1  two adjustments pointing at one mirror are told so (mirrorShared 2).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { createIntercompanyTransaction, matchIntercompanyTransactions } from '../../../src/modules/accounting/services/reports/intercompanyService';
import { autoGenerateEliminations, type FlaggedEliminationRow } from '../../../src/modules/accounting/services/reports/eliminationGenerator';
import { getEliminationAdjustments, postEliminationAdjustment } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { mirrorApprovedCreditNote } from '../../../src/modules/accounting/services/intercompany/outboxService';
import { approveCreditNote } from '../../../src/modules/accounting/services/ar/creditNoteApproveService';
import { approveCreditNoteRow, asService, co, groupAccounts, inbox, plantArCreditNote, sentInvoice, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
beforeAll(async () => { await L.setup(); await L.monthly(co.A, 2026); await L.monthly(co.B, 2026); await L.monthly(co.B, 2027); }, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const redate = (bill: string, date: string) => pool.query('UPDATE supplier_invoices SET invoice_date = $2::date, due_date = $2::date + 30 WHERE id = $1', [bill, date]);
async function bookedOn(date: string, billDate = date) { const m = await L.accepted({ date }); await redate(m.bill, billDate); await L.approveBill(m.bill); return m; }
const manual = (src: string, tgt: string, type: string, amount: number, date: string) => asService(pool, U.ab, src, () => createIntercompanyTransaction({
  groupId: co.G, sourceCompanyId: src, targetCompanyId: tgt, transactionType: type, amount, transactionDate: date, description: `manual ${type}` }));
/** A matched manual pair: A's sale to B and B's purchase from A. */
async function pair(amount: number, date: string) {
  const r1 = await manual(co.A, co.B, 'sale', amount, date);
  const r2 = await manual(co.B, co.A, 'purchase', amount, date);
  await asService(pool, U.ab, co.A, () => matchIntercompanyTransactions(r1.id, r2.id, co.G, U.ab));
  return [r1.id as string, r2.id as string];
}
async function gen(from = '2026-01-01', to = '2026-01-31') {
  const flagged: FlaggedEliminationRow[] = [];
  const made = await asService(pool, U.ab, co.A, () => autoGenerateEliminations(co.G, from, to, flagged));
  return { made, flagged: flagged.map((f) => f.transactionId) };
}
const list = (from = '2026-01-01', to = '2026-12-31') => asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, from, to));
const draftOf = async (row: string) => (await pool.query("SELECT id FROM consolidation_adjustments WHERE group_id = $1 AND source_intercompany_id = $2", [co.G, row])).rows[0].id as string;
const post = (id: string, confirm = false) => asService(pool, U.ab, co.A, () => postEliminationAdjustment(id, co.G, confirm)).then(() => 'posted', (e: Error) => e.message);

describe('R13-M1 / M2: eliminated automatically, judged at the later document date, for drafts and posted rows', () => {
  it('B1: the receiver books on 5 Feb a sale of 15 Jan: the January draft and, once posted, the row are told it IS eliminated automatically', async () => {
    await bookedOn('2026-01-15', '2026-02-05');
    const [r1] = await pair(1000, '2026-01-15');
    await gen();
    const d = await draftOf(r1);
    expect((await list()).find((a) => a.id === d)!.mirrorStands).toBe(true);
    expect(await post(d)).toMatch(/which is eliminated automatically and is not matched to any row yet\. If it is the same sale, posting this would eliminate it twice/);
    expect(await post(d, true)).toBe('posted');
    expect((await list()).find((a) => a.id === d)!.mirrorStands).toBe(true);
  });

  it('B1c: posted while the mirror was pending (no confirm asked), then booked on 5 Feb: the posted row is told it IS eliminated', async () => {
    const s = await sentInvoice(pool, { date: '2026-01-15' });
    const [r1] = await pair(1000, '2026-01-15');
    await gen();
    const d = await draftOf(r1);
    expect(await post(d)).toBe('posted');
    await inbox.accept(U.b, co.B, s.id);
    const bill = (await pool.query('SELECT target_doc_id FROM intercompany_messages WHERE id = $1', [s.id])).rows[0].target_doc_id as string;
    await redate(bill, '2026-02-05'); await L.approveBill(bill);
    const row = (await list()).find((a) => a.id === d)!;
    expect([row.status, row.mirroredDuplicateOf ? 'warned' : 'none', row.mirrorStands]).toEqual(['posted', 'warned', true]);
  });

  it('a mirror whose receiver journal is reversed later in the draft\'s own period (the message stays accepted): not eliminated automatically for that period', async () => {
    const m = await bookedOn('2026-01-15');
    const [r1] = await pair(1000, '2026-01-15');
    await gen();
    const d = await draftOf(r1);
    expect((await list()).find((a) => a.id === d)!.mirrorStands).toBe(true);
    // the receiver's bill journal reversed on 25 January: after the later document date (15 Jan) and inside the draft's period (January),
    // so only the period-end judgement sees it (round 16: a reversal AFTER the period is the mirror's own counter-elimination later)
    const je = (await pool.query('SELECT gl_journal_entry_id AS je FROM supplier_invoices WHERE id = $1', [m.bill])).rows[0].je as string;
    const rev = (await pool.query(`INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id)
      SELECT '2026-01-25', 'reversal', source, 'draft', created_by, company_id FROM gl_journal_entries WHERE id = $1 RETURNING id`, [je])).rows[0].id as string;
    await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description)
      SELECT $2, gl_account_id, credit, debit, company_id, 'reversal' FROM gl_journal_lines WHERE journal_entry_id = $1`, [je, rev]);
    await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now(), reversal_of_id = $2 WHERE id = $1", [rev, je]);
    const row = (await list()).find((a) => a.id === d)!;
    expect([row.mirroredDuplicateOf ? 'warned' : 'none', row.mirrorStands]).toEqual(['warned', false]);
  });

  it('B5: a cut-off sale (30 Dec, booked 2 Jan): the draft is told the mirror is NOT eliminated automatically; never "eliminated twice"', async () => {
    await bookedOn('2026-12-30', '2027-01-02');
    const [r1] = await pair(1000, '2026-12-30');
    await gen('2026-12-01', '2026-12-31');
    const d = await draftOf(r1);
    expect((await list('2026-12-01', '2026-12-31')).find((a) => a.id === d)!.mirrorStands).toBe(false);
    const msg = await post(d);
    expect(msg).toMatch(/NOT eliminated automatically for the period to 2026-12-31: this may be the sale's only elimination/);
    expect(msg).not.toMatch(/twice/);
    expect(msg).not.toMatch(/eliminate the sale twice\. Confirm to post it anyway/);
  });
});

describe('R13-M3: a row of the SUM of the month\'s mirrors', () => {
  it('B3: three mirrored R1 000 invoices in January, one manual row of 3 000 on 31 Jan: flagged, refused without a confirm', async () => {
    await bookedOn('2026-01-05'); await bookedOn('2026-01-12'); await bookedOn('2026-01-20');
    const [r1] = await pair(3000, '2026-01-31');
    expect((await gen()).flagged).toContain(r1);
    expect(await post(await draftOf(r1))).toMatch(/Possibly the same sale as 3 mirrored documents of January 2026: /);
  });

  it('B3b: an invoice of 1 000 and its credit note of -200, one manual row of 800: flagged', async () => {
    await bookedOn('2026-01-15');
    const cn = await plantArCreditNote(pool, { date: '2026-01-20' });
    await approveCreditNoteRow(pool, cn);
    await asService(pool, U.a, co.A, () => mirrorApprovedCreditNote(co.A, cn));
    const mid = (await pool.query('SELECT id FROM intercompany_messages WHERE source_doc_id = $1', [cn])).rows[0].id as string;
    await inbox.accept(U.b, co.B, mid);
    const note = (await pool.query("SELECT id FROM credit_notes WHERE company_id = $1 AND type = 'supplier'", [co.B])).rows[0].id as string;
    await asService(pool, U.b, co.B, () => approveCreditNote(co.B, note, U.b));
    const [r1] = await pair(800, '2026-01-31');
    expect((await gen()).flagged).toContain(r1);
  });

  it('not flagged: the month\'s mirrors sum to 2 000 and the row is 2 500', async () => {
    await bookedOn('2026-01-05'); await bookedOn('2026-01-12');
    const [r1] = await pair(2500, '2026-01-31');
    expect((await gen()).flagged).not.toContain(r1);
  });
});

describe('R13-M4 / L1', () => {
  it('B2: the pair\'s purchase row (B -> A) is flagged as well as the sale, and is refused without a confirm', async () => {
    // a real group maps B's revenue and A's expense too: the purchase row's elimination then lands on the mirror's group accounts
    const bRev = crypto.randomUUID(); const aExp = crypto.randomUUID();
    await pool.query(`INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active) VALUES
      ($1, $2, 'R14BRV', 'B revenue', 'revenue', 'credit', true), ($3, $4, 'R14AEX', 'A expense', 'expense', 'debit', true)`, [bRev, co.B, aExp, co.A]);
    await pool.query('INSERT INTO group_coa_mappings(group_id, group_account_id, company_id, company_account_id) VALUES ($1, $2, $3, $4), ($1, $5, $6, $7)',
      [co.G, groupAccounts.rev, co.B, bRev, groupAccounts.exp, co.A, aExp]);
    try {
      await bookedOn('2026-01-15');
      const [r1, r2] = await pair(1000, '2026-01-15');
      expect((await gen()).flagged.sort()).toEqual([r1, r2].sort());
      expect(await post(await draftOf(r2))).toMatch(/Possibly the same sale as mirrored document/);
    } finally {
      await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]);
      await pool.query('DELETE FROM group_coa_mappings WHERE group_id = $1 AND company_account_id = ANY($2)', [co.G, [bRev, aExp]]);
      await pool.query('DELETE FROM gl_accounts WHERE id = ANY($1)', [[bRev, aExp]]);
    }
  });

  it('B\'s own sale to A, and A\'s purchase from B, are not A\'s sale to B: not flagged', async () => {
    await bookedOn('2026-01-15');
    const own = await manual(co.B, co.A, 'sale', 1000, '2026-01-15');
    const buys = await manual(co.A, co.B, 'purchase', 1000, '2026-01-15');
    await pool.query("UPDATE intercompany_transactions SET match_status = 'matched' WHERE id = ANY($1)", [[own.id, buys.id]]);
    const g = await gen();
    expect(g.flagged).not.toContain(own.id);
    expect(g.flagged).not.toContain(buys.id);
  });

  it('B4: two posted manual sales pointing at one mirror: each is told it is one of 2', async () => {
    await bookedOn('2026-01-15');
    const a = await manual(co.A, co.B, 'sale', 1000, '2026-01-15');
    const b = await manual(co.A, co.B, 'sale', 1000, '2026-01-15');
    await pool.query("UPDATE intercompany_transactions SET match_status = 'matched' WHERE id = ANY($1)", [[a.id, b.id]]);
    await gen();
    for (const r of [a.id, b.id]) await post(await draftOf(r), true);
    const shared = (await list()).filter((x) => !x.automatic).map((x) => x.mirrorShared);
    expect(shared).toEqual([2, 2]);
  });
});
