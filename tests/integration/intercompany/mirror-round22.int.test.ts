/**
 * Intercompany P2, round 22 (the blind review of round 21), the listing improvements (round 22's manual-elimination half was descoped, see
 * mirror-manual-elimination-refused.int.test.ts):
 *  M-2  a row whose message the receiver REJECTED, DISMISSED or FAILED is listed, with the right reason; a PENDING one is not (it waits in the inbox);
 *  L-1  a bill dated after the period and after today eliminates on its own date: not stuck;
 *  L-3  a counter-elimination is dated by its own event: a row eliminated in February and reversed by the receiver in November is listed
 *       for a window holding both, never for February or November alone (stated limit); the November derived read carries the reversal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { cancelSupplierInvoice } from '../../../src/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { getMirroredEliminations, type DroppedMirroredElimination } from '../../../src/modules/accounting/services/reports/mirrorEliminations';
import { asService, co, inbox, sentInvoice, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';
import { withoutTrigger } from './intercompany.session';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
beforeAll(async () => {
  await L.setup();
  for (const y of [2026, 2099]) { await L.monthly(co.A, y); await L.monthly(co.B, y); }
  await L.monthly(co.B, 2027); await L.monthly(co.B, 2100);
}, 90000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const redate = (bill: string, date: string) => pool.query('UPDATE supplier_invoices SET invoice_date = $2::date, due_date = $2::date + 30 WHERE id = $1', [bill, date]);
async function dropped(from: string, to: string, user: string = U.ab, company: string = co.A) {
  const out: DroppedMirroredElimination[] = [];
  await asService(pool, user, company, () => getMirroredEliminations(co.G, from, to, out));
  return out;
}

describe('M-2: a row the receiver will not take is listed, with the right reason', () => {
  it('REJECTED (with the receiver\'s reason), DISMISSED and FAILED are listed; PENDING is not', async () => {
    const rej = await sentInvoice(pool, { date: '2026-03-05' });
    const dis = await sentInvoice(pool, { date: '2026-03-06' });
    const fail = await sentInvoice(pool, { date: '2026-03-07' });
    await sentInvoice(pool, { date: '2026-03-08' });                     // pending: waits in B's inbox
    expect((await inbox.reject(U.b, co.B, rej.id, { reason: 'Wrong entity' })).state.statusCode).toBe(200);
    expect((await inbox.dismiss(U.b, co.B, dis.id)).state.statusCode).toBe(200);
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard',
      (q) => q.query("UPDATE intercompany_messages SET status = 'failed', error = 'x' WHERE id = $1", [fail.id]));
    const out = await dropped('2026-03-01', '2026-03-31');
    expect(out.map((d) => d.code)).toEqual(['rejected', 'dismissed', 'failed']);
    expect(out[0]!.detail).toBe('the receiver rejected it: Wrong entity');
    expect(out[1]!.detail).toMatch(/dismissed/);
    expect(out[2]!.detail).toMatch(/automatic acceptance failed/);
    expect(out.every((d) => d.kind === 'unresolved')).toBe(true);
    expect(await L.derived('2026-03-01', '2026-03-31')).toHaveLength(0);  // (nothing eliminates them: why they are listed)
  });

  it('a rejected row whose sale the sender then cancels is gone: not listed', async () => {
    const a = await sentInvoice(pool, { date: '2026-03-05' });
    const b = await sentInvoice(pool, { date: '2026-03-06' });
    await inbox.reject(U.b, co.B, a.id, { reason: 'No' }); await inbox.reject(U.b, co.B, b.id, { reason: 'No' });
    expect(await dropped('2026-03-01', '2026-03-31')).toHaveLength(2);
    await L.cancelSender(a.inv.id);
    const out = await dropped('2026-03-01', '2026-03-31');
    expect(out).toHaveLength(1);
    expect(out[0]!.description).not.toBe('');
  });
});

describe('L-1: a bill dated after the period AND after today eliminates on its own date: not stuck', () => {
  it('a March sale with a bill dated 2 Apr 2099 (display status unmatched) is not listed for March (the pair stands as of all links), a variance is', async () => {
    const m = await L.accepted({ date: '2099-03-05' });
    await redate(m.bill, '2099-04-02');
    await L.approveBill(m.bill);
    await L.unbind();                                                    // (the display columns say 'unmatched': only the ledgers say what stands)
    expect((await L.rows()).map((r) => r.match_status)).toEqual(['unmatched']);
    expect(await dropped('2099-03-01', '2099-03-31')).toEqual([]);
    const v = await L.accepted({ date: '2099-03-06' });                  // booked in 2100: another financial year, never eliminated
    await redate(v.bill, '2100-01-04');
    await L.approveBill(v.bill);
    expect((await dropped('2099-03-01', '2099-03-31')).map((d) => d.code)).toEqual(['variance']);
  });
});

describe('L-3: a counter-elimination is dated by its own event (a stated limit)', () => {
  it('eliminated in February, reversed by the receiver in November (a closed February rolls the reversal): listed for a window with both, not for either alone', async () => {
    const m = await L.accepted({ date: '2026-02-10' });
    await L.approveBill(m.bill);
    await pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1 AND start_date = '2026-02-01'", [co.B]);
    try { await asService(pool, U.b, co.B, () => cancelSupplierInvoice(co.B, m.bill, U.b)); } finally {
      await pool.query("UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1 AND start_date = '2026-02-01'", [co.B]);
    }
    const rev = (await pool.query('SELECT entry_date::text AS d FROM gl_journal_entries WHERE company_id = $1 AND reversal_of_id IS NOT NULL', [co.B])).rows[0].d as string;
    expect(rev > '2026-02-28').toBe(true);
    const row = await L.groupRow();
    expect(await dropped('2026-02-01', '2026-02-28')).toEqual([]);          // it stood at the end of February
    expect(await dropped(rev.slice(0, 8) + '01', rev)).toEqual([]);         // the row is dated February: outside the reversal's month
    const wide = await dropped('2026-02-01', rev);
    expect(wide).toHaveLength(1);
    expect(wide[0]).toMatchObject({ transactionId: row.id, kind: 'unresolved', code: 'cancelled' });
    const counter = await L.derived(rev.slice(0, 8) + '01', rev);           // (the reversal is still visible, as a labelled derived line)
    expect(counter.map((c) => c.kind)).toEqual(['reverse']);
  });
});
