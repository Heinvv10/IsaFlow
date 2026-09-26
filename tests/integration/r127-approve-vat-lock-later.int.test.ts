// R-127 re-check LOW (b) — the filed-period refusal over-refused. When the bill
// is dated in a filed VAT period but the bank paid it in a LATER, OPEN one, the
// provisional's VAT was claimed in the open period. Dating the reclass with the
// provisional's own date nets there: the provisional's claim (+) and the reclass
// (−) cancel in the open period, the bill's VAT is claimed once through its late
// claim, and nothing touches the filed period. So that case settles; only a
// provisional that ALSO sits in a filed period is refused (r127-approve-vat-lock).
import { describe, expect, it } from 'vitest';
import supplierInvoicesAction from '../../pages/api/accounting/supplier-invoices-action';
import {
  callRoute, company, invoiceState, paymentsFor, pool, seedDoc, seedInvoice, seedProvisional, today,
  useR127Fixture, user, vatGl,
} from './r127-double-booking.helpers';

useR127Fixture();

// The previous calendar month is filed; the bank line (today) is in the open one.
const firstOfThisMonth = new Date(`${today.slice(0, 8)}01T00:00:00Z`);
const lastMonthEnd = new Date(firstOfThisMonth.getTime() - 86_400_000).toISOString().slice(0, 10);
const lastMonthStart = `${lastMonthEnd.slice(0, 8)}01`;

describe('R-127: a bill dated in a filed period, paid by the bank in an open one', () => {
  it('settles, dating the reclass with the provisional: VAT claimed once, the filed period untouched', async () => {
    const clearing = (await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,is_system_account,account_subtype)
       VALUES($1,'R127LC','R127 Input VAT - late claims','asset','debit',true,true,'vat_input_late_claim') RETURNING id`,
      [company])).rows[0].id as string;
    const doc = await seedDoc();
    const { je, bt } = await seedProvisional({ totalAmount: 115.00, evidencedBy: doc });
    await pool.query(
      `INSERT INTO vat_period_locks(company_id,period_start,period_end,output_tax,input_tax,net_vat,posted_through,locked_by,actor_type)
       VALUES($1,$2,$3,0,0,0,NOW(),$4,'human')`,
      [company, lastMonthStart, lastMonthEnd, user]);
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 115.00, invoiceDate: lastMonthEnd });

    const res = await callRoute(supplierInvoicesAction, '/api/accounting/supplier-invoices-action',
      { action: 'approve', invoiceId });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect((await invoiceState(invoiceId)).status).toBe('paid');

    const [payment] = await paymentsFor(bt, invoiceId);
    const invoiceJe = (await invoiceState(invoiceId)).gl_journal_entry_id!;
    const ids = [je, invoiceJe, payment!.gl_journal_entry_id!];
    // Every journal the slip produced, the late claim's companion included.
    const net = async (account: string, extra = 'TRUE') => Number((await pool.query(
      `SELECT COALESCE(SUM(l.debit - l.credit),0) AS n FROM gl_journal_lines l
       JOIN gl_journal_entries e ON e.id = l.journal_entry_id
       WHERE e.status='posted' AND (e.id = ANY($1::uuid[]) OR e.late_claim_of_id = ANY($1::uuid[]))
         AND l.gl_account_id = $2 AND ${extra}`, [ids, account])).rows[0].n);

    expect(await net(vatGl)).toBe(15);
    expect(await net(clearing)).toBe(0);
    // No VAT figure dated inside the filed period.
    expect(await net(vatGl, `e.entry_date BETWEEN '${lastMonthStart}' AND '${lastMonthEnd}'`)).toBe(0);
    // The reclass and the payment carry the bank date, not the filed bill date.
    const reclassDate = (await pool.query('SELECT entry_date::text AS d FROM gl_journal_entries WHERE id=$1',
      [payment!.gl_journal_entry_id])).rows[0].d as string;
    expect(reclassDate).toBe(today);
  });
});
