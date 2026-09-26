// R-127 review HIGH — the settlement runs AFTER the invoice's journal has posted
// and its status moved. supplier-invoices-action answers every error 400, and
// withAuth COMMITs a 4xx, so a settlement that throws must take the invoice's
// posting down with it — otherwise the double booking is committed for good
// (re-approve refused as already approved, Post to GL a no-op). Driven through
// the REAL route so withAuth's commit semantics apply; the inTx helper
// ROLLBACKs on a throw and hid this.
import { describe, expect, it, vi } from 'vitest';
import supplierInvoicesAction from '../../pages/api/accounting/supplier-invoices-action';
import {
  callRoute, company, companySnapshot, invoiceState, pool, seedDoc, seedInvoice, seedProvisional,
  slipLedger, useR127Fixture, bankGl, vatGl,
} from './r127-double-booking.helpers';

// Fault injection ONLY: the real application service, except that a plan for
// the flagged amount throws — a refusal raised in JS after the invoice journal,
// the reclass and the payment row have all been written.
const inject = vi.hoisted(() => ({ amount: -1 }));
vi.mock('@/modules/accounting/services/ap/supplierPaymentApplicationService', async (orig) => {
  const real = await orig<typeof import('@/modules/accounting/services/ap/supplierPaymentApplicationService')>();
  const { SupplierPaymentRefusal } = await import('@/modules/accounting/services/ap/supplierPaymentRefusal');
  return {
    ...real,
    planSupplierPaymentApplication: async (...a: Parameters<typeof real.planSupplierPaymentApplication>) => {
      if (a[2][0]?.amount === inject.amount) throw new SupplierPaymentRefusal('R127 injected settlement failure');
      return real.planSupplierPaymentApplication(...a);
    },
  };
});

useR127Fixture();

const approveViaRoute = (invoiceId: string) => callRoute(
  supplierInvoicesAction, '/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId });

describe('R-127: approval through the route is all-or-nothing', () => {
  it('a settlement failure after the invoice journal posted commits NOTHING', async () => {
    const doc = await seedDoc();
    await seedProvisional({ totalAmount: 601.15, evidencedBy: doc });
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 601.15 });
    const before = await companySnapshot(invoiceId);

    inject.amount = 601.15;
    try {
      const res = await approveViaRoute(invoiceId);
      expect(res.statusCode).toBe(400);
    } finally {
      inject.amount = -1;
    }
    expect(await companySnapshot(invoiceId)).toEqual(before);
  });

  it('a provisional line on an inactive account and an inactive cost centre still settles (historical copy)', async () => {
    const inactiveExpense = crypto.randomUUID();
    const inactiveCc = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype)
       VALUES($1,$2,'R127EXOLD','R127 Retired expense','expense','debit',true,'operating_expense')`,
      [inactiveExpense, company]);
    await pool.query(
      "INSERT INTO cost_centres(id,company_id,code,name,is_active,cc_type) VALUES($1,$2,'R127CC','R127 retired CC',true,'cc1')",
      [inactiveCc, company]);
    const doc = await seedDoc();
    const { je, bt } = await seedProvisional({
      totalAmount: 602.30, evidencedBy: doc, accounts: { bank: bankGl, expense: inactiveExpense, vat: vatGl },
    });
    await pool.query('UPDATE gl_journal_lines SET cc1_id=$2 WHERE journal_entry_id=$1 AND gl_account_id=$3', [je, inactiveCc, inactiveExpense]);
    // Both retired AFTER the provisional posted — the ordinary way a historical line names them.
    await pool.query('UPDATE gl_accounts SET is_active=false WHERE id=$1', [inactiveExpense]);
    await pool.query('UPDATE cost_centres SET is_active=false WHERE id=$1', [inactiveCc]);
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 602.30 });

    const res = await approveViaRoute(invoiceId);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect((await invoiceState(invoiceId)).status).toBe('paid');
    expect(await slipLedger(je, bt, invoiceId)).toMatchObject({ vat: 78.56, ap: 0, bank: -602.30 });
    const retired = Number((await pool.query(
      `SELECT COALESCE(SUM(l.debit - l.credit),0) AS n FROM gl_journal_lines l
       JOIN gl_journal_entries e ON e.id = l.journal_entry_id
       WHERE l.gl_account_id=$1 AND e.status='posted' AND e.reversed_at IS NULL`, [inactiveExpense])).rows[0].n);
    expect(retired).toBe(0);
  });
});
