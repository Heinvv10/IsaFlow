// R-127 review HIGH (a) — the ordinary case of a slip processed after its VAT201
// was filed. The provisional (bank date) already claimed the input VAT in that
// filed period. Approving the invoice from the same slip through the route opts
// into the s16(3) late claim, so the invoice's own journal posts and moves its
// VAT into the next open period — a SECOND claim — and then the reclass, which
// would have cancelled it, credits VAT input on a locked date and is refused.
// Because withAuth COMMITs the 400, that used to leave the late claim standing.
//
// Decided: the approval is REFUSED, before anything is written. The late-claim
// rules refuse an input reduction ('input_reduction'), so the reclass cannot be
// given the same treatment, and the only other date that nets the VAT is inside
// the filed period. Refusing leaves VAT claimed exactly once — the provisional's,
// in the filed return — and the filed period untouched.
import { describe, expect, it } from 'vitest';
import supplierInvoicesAction from '../../pages/api/accounting/supplier-invoices-action';
import {
  callRoute, company, companySnapshot, pool, seedDoc, seedInvoice, seedProvisional, today,
  useR127Fixture, user, vatGl,
} from './r127-double-booking.helpers';

useR127Fixture();

const monthStart = `${today.slice(0, 8)}01`;
const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);

describe('R-127: an invoice dated in a filed VAT period whose slip backs a provisional', () => {
  it('is refused through the route with nothing written, VAT claimed once', async () => {
    await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,is_system_account,account_subtype)
       VALUES($1,'R127LC','R127 Input VAT - late claims','asset','debit',true,true,'vat_input_late_claim')`,
      [company]);
    const doc = await seedDoc();
    await seedProvisional({ totalAmount: 701.50, evidencedBy: doc });
    // The period holding the bank date and the slip date is filed.
    await pool.query(
      `INSERT INTO vat_period_locks(company_id,period_start,period_end,output_tax,input_tax,net_vat,posted_through,locked_by,actor_type)
       VALUES($1,$2,$3,0,91.50,-91.50,NOW(),$4,'human')`,
      [company, monthStart, monthEnd, user]);
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 701.50 });
    const before = await companySnapshot(invoiceId);

    const res = await callRoute(supplierInvoicesAction, '/api/accounting/supplier-invoices-action',
      { action: 'approve', invoiceId });

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/filed VAT period/i);
    expect(await companySnapshot(invoiceId)).toEqual(before);
    // Input VAT across the company: the provisional's R91.50 and nothing else.
    const vat = Number((await pool.query(
      `SELECT COALESCE(SUM(l.debit - l.credit),0) AS n FROM gl_journal_lines l
       JOIN gl_journal_entries e ON e.id = l.journal_entry_id
       WHERE e.company_id=$1 AND l.gl_account_id=$2 AND e.status='posted' AND e.reversed_at IS NULL`,
      [company, vatGl])).rows[0].n);
    expect(vat).toBe(91.5);
  });
});
