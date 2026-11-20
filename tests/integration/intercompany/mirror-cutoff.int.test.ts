/**
 * Intercompany P2, the rulings on what a group row eliminates: a cut-off is judged by FINANCIAL YEAR of the receiver's calendar (a sale on 30 Nov
 * booked by the receiver on 2 Dec eliminates; one on 30 Dec booked on 2 Jan does not: variance, "cut-off: different financial years"), with
 * the monthly periods real companies have (the single yearly period the fixtures start with hid month-end); a capitalised cost stays a
 * variance whose reason the receiver sees on its inbox row; a credit note's elimination is the invoice's with the sides swapped in positive
 * amounts; and a group writer of only a THIRD member company reads the same derived eliminations.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { approveCreditNote } from '../../../src/modules/accounting/services/ar/creditNoteApproveService';
import { getPostedEliminations } from '../../../src/modules/accounting/services/reports/consolidatedTrialBalanceService';
import { asService, co, dataOf, inbox, plantArCreditNote, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
const { extra, groupRow, adjustments, derived, approveBill, accepted } = L;
beforeAll(async () => { await L.setup(); await L.monthly(co.B, 2026); await L.monthly(co.B, 2027); }, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

const redate = (bill: string, date: string) => pool.query('UPDATE supplier_invoices SET invoice_date = $2::date, due_date = $2::date + 30 WHERE id = $1', [bill, date]);

describe('cut-off by financial year, with monthly periods', () => {
  it('the sender sells on 30 Nov and the receiver books it on 2 Dec: same financial year, matched and eliminated', async () => {
    const m = await accepted({ date: '2026-11-30' });
    await redate(m.bill, '2026-12-02');
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'matched', variance_reason: null });
    expect(await derived()).toHaveLength(1);
  });

  it('the sender sells on 30 Dec and the receiver books it on 2 Jan: different financial years, a variance with that reason, nothing eliminated', async () => {
    const m = await accepted({ date: '2026-12-30' });
    await redate(m.bill, '2027-01-02');
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'variance', variance_reason: 'cut-off: different financial years' });
    expect(await derived()).toHaveLength(0);
  });
});

describe('a capitalised cost: a variance the receiver can read', () => {
  it('the asset line stays a variance (an unrealised-profit entry is needed), and the reason is on the row and on the receiver\'s handled inbox row', async () => {
    const m = await accepted();
    await pool.query('UPDATE supplier_invoice_items SET gl_account_id = $2 WHERE supplier_invoice_id = $1', [m.bill, extra.asset]);
    await approveBill(m.bill);
    const reason = (await groupRow()).variance_reason as string;
    expect(reason).toMatch(/capitalised cost needs an unrealised-profit entry/);
    const handled = dataOf<{ items: Array<{ id: string; groupMatch: string; varianceReason: string }> }>(await inbox.list(U.b, co.B, { filter: 'handled' }));
    expect(handled.items.find((i) => i.id === m.id)).toMatchObject({ groupMatch: 'variance', varianceReason: reason });
    expect(await derived()).toHaveLength(0);
  });
});

describe('a credit note\'s elimination is the invoice\'s with the sides swapped, in positive amounts', () => {
  it('no negative debit or credit; the posted trial balance nets the same as the negative form (revenue credit 200, expense debit 200 against a R200 note)', async () => {
    const cn = await plantArCreditNote(pool);
    await asService(pool, U.a, co.A, () => approveCreditNote(co.A, cn, U.a));
    const mid = (await pool.query('SELECT id FROM intercompany_messages WHERE source_doc_id = $1', [cn])).rows[0].id as string;
    expect((await inbox.accept(U.b, co.B, mid)).state.statusCode).toBe(200);
    const note = (await pool.query("SELECT id FROM credit_notes WHERE company_id = $1 AND type = 'supplier'", [co.B])).rows[0].id as string;
    await asService(pool, U.b, co.B, () => approveCreditNote(co.B, note, U.b));
    expect(await groupRow()).toMatchObject({ match_status: 'matched' });
    expect(Number((await groupRow()).amount)).toBe(-200);
    const [made] = await derived();
    expect(made!.lines.every((l) => l.debit >= 0 && l.credit >= 0)).toBe(true);
    const net = Object.fromEntries((await asService(pool, U.ab, co.A, () => getPostedEliminations(co.G, '2026-01-01', '2026-12-31'))).map((l) => [l.groupAccountType, l.debit - l.credit]));
    expect(net).toEqual({ revenue: -200, expense: 200 });   // the negative form was revenue debit -200 / expense credit -200: the same nets
  });
});

describe('a group writer whose own company is only a THIRD member of the group', () => {
  it('reads the same derived eliminations: the function judges the group rows, not the rows a session UPDATE policy would let it write', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    // x: an owner of C (a member of the group, party to no row) and a VIEWER of A and B (so it reads their chart mappings, and updates none of their rows)
    await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [co.G, co.C]);
    await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $4, 'owner'), ($2, $4, 'viewer'), ($3, $4, 'viewer')", [co.C, co.A, co.B, U.x]);
    try {
      const made = await derived('2026-01-01', '2026-12-31', U.x, co.C);
      expect(made).toHaveLength(1);
      expect(await adjustments()).toHaveLength(0);
    } finally {
      await pool.query('DELETE FROM company_users WHERE user_id = $1 AND company_id = ANY($2)', [U.x, [co.A, co.B, co.C]]);
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1 AND company_id = $2', [co.G, co.C]);
    }
  });
});
