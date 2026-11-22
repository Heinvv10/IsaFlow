/**
 * Intercompany P2, round 21 M1: a mirrored row that NO path eliminates (the generator skips mirrored rows, the manual match refuses them, the
 * derived elimination needs the receiver's journal to carry the figures in the same financial year) is SURFACED with the mirrored rows the
 * derivation drops for an unmapped account: `droppedMirrored` entries of kind 'unresolved', for the Eliminations page and the consolidated
 * reports, so the group knows a manual elimination with a reason is needed. Only a row the receiver has ACTED on (approved or cancelled) and
 * that gives no elimination now or later is listed: a draft bill, a bill approved after the period (it eliminates then), a sender's cancel and
 * a row outside the period are not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { cancelSupplierInvoice } from '../../../src/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { getEliminationAdjustments } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { getPostedEliminationsSplit } from '../../../src/modules/accounting/services/reports/consolidatedTrialBalanceService';
import { getMirroredEliminations, type DroppedMirroredElimination } from '../../../src/modules/accounting/services/reports/mirrorEliminations';
import { asService, co, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
beforeAll(async () => { await L.setup(); await L.monthly(co.B, 2026); await L.monthly(co.B, 2027); }, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const redate = (bill: string, date: string) => pool.query('UPDATE supplier_invoices SET invoice_date = $2::date, due_date = $2::date + 30 WHERE id = $1', [bill, date]);
/** The sender sold on 30 Dec 2026 and the receiver booked it on 2 Jan 2027: a variance (cut-off), nothing eliminated. */
async function variance(date = '2026-12-30', billDate = '2027-01-02') {
  const m = await L.accepted({ date });
  await redate(m.bill, billDate);
  await L.approveBill(m.bill);
  return m;
}
async function dropped(from: string, to: string, user: string = U.ab, company: string = co.A) {
  const out: DroppedMirroredElimination[] = [];
  await asService(pool, user, company, () => getMirroredEliminations(co.G, from, to, out));
  return out;
}

describe('M1: a mirrored row no path eliminates is surfaced', () => {
  it('a variance row (cut-off: different financial years) is listed as unresolved with its date, amount and the reason; nothing is eliminated', async () => {
    const m = await variance();
    const row = await L.groupRow();
    expect(row).toMatchObject({ match_status: 'variance', variance_reason: 'cut-off: different financial years' });
    expect(await L.derived('2026-12-01', '2026-12-31')).toHaveLength(0);
    const out = await dropped('2026-12-01', '2026-12-31');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'unresolved', transactionId: row.id, keyDate: '2026-12-30', amount: Number(row.amount) });
    expect(out[0]!.detail).toContain('cut-off: different financial years');
    expect(out[0]!.description).toContain(String(row.description).trim());
    expect(m.id).toBeTruthy();
  });

  it('the Eliminations list and the reports\' derived read carry it (the page and the consolidated reports read the same list)', async () => {
    await variance();
    const list: DroppedMirroredElimination[] = [];
    await asService(pool, U.ab, co.A, () => getEliminationAdjustments(co.G, '2026-12-01', '2026-12-31', list));
    expect(list.map((d) => d.kind)).toEqual(['unresolved']);
    const report: DroppedMirroredElimination[] = [];
    await asService(pool, U.ab, co.A, () => getPostedEliminationsSplit(co.G, '2026-12-01', '2026-12-31', '1900-01-01', report));
    expect(report.map((d) => d.kind)).toEqual(['unresolved']);
  });

  it('a standing pair, a draft bill, a sender\'s cancel and a sale the sender dated after the period are NOT listed', async () => {
    const ok = await L.accepted({ date: '2026-03-05' });                 // standing: eliminated in March
    await L.approveBill(ok.bill);
    await L.accepted({ date: '2026-03-06' });                            // a draft bill: nothing yet, nothing stuck
    const gone = await variance('2026-03-08', '2027-01-03');             // a variance the sender then cancels: the sale is gone
    await L.cancelSender(gone.inv.id);
    await variance('2026-11-20', '2027-01-04');                          // a variance of a sale dated in November
    expect(await dropped('2026-03-01', '2026-03-31')).toEqual([]);
    expect((await dropped('2026-11-01', '2026-11-30')).map((d) => d.kind)).toEqual(['unresolved']);
  });

  it('a display status the sync never wrote (the hook failed: the row reads unmatched) does not list a pair the ledgers still support, now or later', async () => {
    const std = await L.accepted({ date: '2026-03-05' });                // standing in March
    await L.approveBill(std.bill);
    const late = await L.accepted({ date: '2026-03-07' });               // its bill is booked in April: it eliminates then
    await redate(late.bill, '2026-04-10');
    await L.approveBill(late.bill);
    await L.unbind();                                                    // (every row back to "never matched": only the ledgers say what stands)
    expect((await L.rows()).map((r) => r.match_status)).toEqual(['unmatched', 'unmatched']);
    expect(await L.derived('2026-03-01', '2026-03-31')).toHaveLength(1); // (the standing pair is eliminated in March, the April one in April)
    expect(await dropped('2026-03-01', '2026-03-31')).toEqual([]);       // (neither is stuck: one stands now, the other will stand in April)
    expect(await L.derived('2026-04-01', '2026-04-30')).toHaveLength(1);
  });

  it('a pair that STOOD at the period end and was cancelled by the receiver later (a cancel rolled past its closed month) is eliminated in that period: not listed for it', async () => {
    const m = await L.accepted({ date: '2026-02-10' });
    await L.approveBill(m.bill);
    await pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1 AND start_date = '2026-02-01'", [co.B]);
    try { await asService(pool, U.b, co.B, () => cancelSupplierInvoice(co.B, m.bill, U.b)); } finally {
      await pool.query("UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1 AND start_date = '2026-02-01'", [co.B]);
    }
    const rev = (await pool.query("SELECT entry_date::text AS d FROM gl_journal_entries WHERE company_id = $1 AND reversal_of_id IS NOT NULL", [co.B])).rows;
    expect(rev.length === 1 && rev[0].d > '2026-02-28').toBe(true);      // (the reversal is dated after February)
    expect(await L.derived('2026-02-01', '2026-02-28')).toHaveLength(1); // (February is eliminated: the pair stood at its end)
    expect(await dropped('2026-02-01', '2026-02-28')).toEqual([]);
  });

  it('only rows dated in the period are listed (the window is the row\'s date)', async () => {
    await variance('2026-03-12', '2027-01-05');
    expect((await dropped('2026-03-01', '2026-03-31')).map((d) => d.keyDate)).toEqual(['2026-03-12']);
    expect(await dropped('2026-04-01', '2026-04-30')).toEqual([]);
    expect(await dropped('2026-02-01', '2026-02-28')).toEqual([]);
  });

  it('a bill the receiver approved and then CANCELLED leaves the sale uneliminated: listed, with that reason', async () => {
    const m = await L.accepted({ date: '2026-02-10' });
    await L.approveBill(m.bill);
    await asService(pool, U.b, co.B, () => cancelSupplierInvoice(co.B, m.bill, U.b));
    const out = await dropped('2026-02-01', '2026-02-28');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'unresolved', keyDate: '2026-02-10' });
    expect(out[0]!.detail).toMatch(/receiver/i);
  });

  it('a session that is not a member of the group is told nothing (the definer checks membership)', async () => {
    await variance();
    expect(await dropped('2026-12-01', '2026-12-31', U.c, co.C)).toEqual([]);
  });
});
