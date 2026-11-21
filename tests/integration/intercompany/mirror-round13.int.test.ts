/**
 * Intercompany P2, round 13: the duplicate flag is the only guard, so it is WIDE (a missing flag lets a double elimination be posted).
 *  R12-M1  a manual row at the mirror's VAT-inclusive total, on the receiver's bill date, or a few days off is flagged; another amount, or
 *          another month more than 7 days away, is not;
 *  R12-M2  a draft generated while the mirror was pending carries the warning once the mirror is accepted, and posting it is refused with
 *          the mirror named unless the person confirms;
 *  R12-L1  a posted one is told whether the mirror is eliminated automatically (its pair stands), never told to reverse the only elimination;
 *  a mirror with no description is named by its id.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { createIntercompanyTransaction } from '../../../src/modules/accounting/services/reports/intercompanyService';
import { autoGenerateEliminations, type FlaggedEliminationRow } from '../../../src/modules/accounting/services/reports/eliminationGenerator';
import { getEliminationAdjustments, postEliminationAdjustment } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { EliminationPossibleDuplicateError } from '../../../src/modules/accounting/services/reports/eliminationErrors';
import { asService, co, inbox, sentInvoice, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';
import { withoutTrigger } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
const { approveBill, accepted } = L;
beforeAll(async () => { await L.setup(); await L.monthly(co.A, 2026); await L.monthly(co.B, 2026); }, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const redate = (bill: string, date: string) => pool.query('UPDATE supplier_invoices SET invoice_date = $2::date, due_date = $2::date + 30 WHERE id = $1', [bill, date]);
async function mirrored(saleDate = '2026-01-15', billDate = saleDate) {
  const m = await accepted({ date: saleDate });   // R1 000 + R150 VAT
  await redate(m.bill, billDate);
  await approveBill(m.bill);
  return m;
}
/** One manual A -> B sale, matched, of `amount` on `date`. */
async function manualSale(amount: number, date: string) {
  const r = await asService(pool, U.ab, co.A, () => createIntercompanyTransaction({
    groupId: co.G, sourceCompanyId: co.A, targetCompanyId: co.B, transactionType: 'sale', amount, transactionDate: date, description: 'manual sale' }));
  await pool.query("UPDATE intercompany_transactions SET match_status = 'matched' WHERE id = $1", [r.id]);
  return r;
}
const dup = (row: string) => asService(pool, U.ab, co.A, async (q) => (await q.query('SELECT mirror_ref FROM public.intercompany_mirrored_duplicate($1)', [row])).rows);
async function generate(from = '2026-01-01', to = '2026-03-31') {
  const flagged: FlaggedEliminationRow[] = [];
  const made = await asService(pool, U.ab, co.A, () => autoGenerateEliminations(co.G, from, to, flagged));
  return { made, flagged };
}
const list = () => asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, '2026-01-01', '2026-03-31'));

describe('R12-M1: the flag is wide', () => {
  it('A1: the manual row at the mirror\'s VAT-inclusive total (1150 for 1000 + 150): flagged', async () => {
    await mirrored();
    const r = await manualSale(1150, '2026-01-15');
    expect((await generate()).flagged.map((f) => f.transactionId)).toEqual([r.id]);
  });

  it('A2: the manual row on the receiver\'s bill date (5 Feb, for a sale of 15 Jan): flagged', async () => {
    await mirrored('2026-01-15', '2026-02-05');
    const r = await manualSale(1000, '2026-02-05');
    expect((await generate()).flagged.map((f) => f.transactionId)).toEqual([r.id]);
  });

  it('A2b: a day off (30 Jan): flagged; within 7 days of the sale across a month end (3 Feb for 29 Jan, the bill booked in March): flagged', async () => {
    await mirrored('2026-01-29', '2026-03-20');
    const a = await manualSale(1000, '2026-01-30');
    const b = await manualSale(1000, '2026-02-03');
    expect([(await dup(a.id)).length, (await dup(b.id)).length]).toEqual([1, 1]);
  });

  it('not flagged: another amount (999), or another month more than 7 days from both dates (20 Mar)', async () => {
    await mirrored();
    const a = await manualSale(999, '2026-01-15');
    const b = await manualSale(1000, '2026-03-20');
    expect([(await dup(a.id)).length, (await dup(b.id)).length]).toEqual([0, 0]);
  });

  it('a mirror with no description is named by its id', async () => {
    const m = await mirrored();
    const row = m.message.payload.groupTransactionId as string;
    await withoutTrigger(pool, 'intercompany_transactions', 'trg_intercompany_transaction_parties_immutable', (q) => q.query(
      'UPDATE intercompany_transactions SET description = NULL WHERE id = $1', [row]));
    const r = await manualSale(1000, '2026-01-15');
    expect((await dup(r.id))[0]?.mirror_ref).toBe(row);
  });
});

describe('R12-M2: a draft made while the mirror was pending', () => {
  it('is warned on the list once the mirror is accepted, and posting it is refused unless confirmed', async () => {
    const s = await sentInvoice(pool, { date: '2026-01-15' });
    const r = await manualSale(1000, '2026-01-15');
    const first = await generate();
    expect(first.flagged).toEqual([]);
    const draft = first.made.find((a) => a.sourceIntercompanyId === r.id)!;
    expect((await inbox.accept(U.b, co.B, s.id)).state.statusCode).toBe(200);
    const bill = (await pool.query('SELECT target_doc_id FROM intercompany_messages WHERE id = $1', [s.id])).rows[0].target_doc_id as string;
    await redate(bill, '2026-01-15');
    await approveBill(bill);
    const row = (await list()).find((a) => a.id === draft.id)!;
    expect(row.status).toBe('draft');
    expect(row.mirroredDuplicateOf).toMatch(/Invoice/);
    const refused = await asService(pool, U.ab, co.A, () => postEliminationAdjustment(draft.id, co.G)).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(EliminationPossibleDuplicateError);
    expect((refused as Error).message).toMatch(/Possibly the same sale as mirrored document .*Invoice/);
    expect((await list()).find((a) => a.id === draft.id)!.status).toBe('draft');
    await asService(pool, U.ab, co.A, () => postEliminationAdjustment(draft.id, co.G, true));
    expect((await list()).find((a) => a.id === draft.id)!.status).toBe('posted');
  });

  it('a draft with no possible duplicate posts without a confirm', async () => {
    await mirrored();
    const r = await manualSale(777, '2026-01-15');
    const draft = (await generate()).made.find((a) => a.sourceIntercompanyId === r.id)!;
    await asService(pool, U.ab, co.A, () => postEliminationAdjustment(draft.id, co.G));
    expect((await list()).find((a) => a.id === draft.id)!.status).toBe('posted');
  });
});

describe('R12-L1: a posted one is told whether the mirror is eliminated automatically', () => {
  it('the mirror\'s bill accepted but never approved: mirrorStands false; once approved: true', async () => {
    const s = await sentInvoice(pool, { date: '2026-01-15' });
    expect((await inbox.accept(U.b, co.B, s.id)).state.statusCode).toBe(200);
    const r = await manualSale(1000, '2026-01-15');
    const draft = (await generate()).made.find((a) => a.sourceIntercompanyId === r.id)!;
    await asService(pool, U.ab, co.A, () => postEliminationAdjustment(draft.id, co.G, true));
    let row = (await list()).find((a) => a.id === draft.id)!;
    expect([row.mirroredDuplicateOf ? 'warned' : 'none', row.mirrorStands]).toEqual(['warned', false]);
    const bill = (await pool.query('SELECT target_doc_id FROM intercompany_messages WHERE id = $1', [s.id])).rows[0].target_doc_id as string;
    await redate(bill, '2026-01-15');
    await approveBill(bill);
    row = (await list()).find((a) => a.id === draft.id)!;
    expect(row.mirrorStands).toBe(true);
  });
});
