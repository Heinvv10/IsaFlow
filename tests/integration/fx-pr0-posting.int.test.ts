/**
 * FX PR0 review round 1, MEDIUM-1: a foreign draft written while the switch
 * was on posted its USD figure as rands once the switch was off (proven:
 * USD 1 150 @ 18.5 approved with 200, the journal debiting 1 150.00). The
 * approve/post services now refuse it with a 400 before any write, for
 * invoices, bills and credit notes; and the settlement paths that pick their
 * own documents leave a foreign one out instead of failing the whole batch on
 * the database's FX_SETTLEMENT_REFUSED.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import customerInvoicesGl from '../../pages/api/accounting/customer-invoices-gl';
import supplierPayments from '../../pages/api/accounting/supplier-payments';
import batchPayments from '../../pages/api/accounting/batch-payments';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, enableFxDocuments, plantBill } from './r035-approval.helpers';
import { cleanupPr3, noteCompany, noteRoutes, noteState, plantNote } from './r035-pr3.helpers';
import { invoiceRoutes, invoiceState, plantInvoice } from './r035-pr4.helpers';
import { billState, messageOf, routes } from './r035-pr2.helpers';
import { als } from '@/lib/als';
import { fetchOpenCustomerInvoices } from '@/modules/accounting/services/ar/openCustomerInvoices';
import { fetchOpenSupplierBills } from '@/modules/accounting/services/ap/openSupplierBills';
import { fetchInvoiceStates, skipReasonForInvoice } from '@/lib/mcp/tools/allocationApplyRoute';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';
const inv = invoiceRoutes(tokens);
const ap = routes(tokens);
const cn = noteRoutes(tokens);
const DISABLED = /USD (invoice|bill|credit note)s are not enabled for this company/;

beforeAll(async () => { owner = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = ANY($1))', [companies]);
  await pool.query('DELETE FROM supplier_payments WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM supplier_payment_batches WHERE company_id = ANY($1)', [companies]);
  await cleanupPr3(pool, companies, [owner]);
});

/** A company able to post invoices, bills and notes, holding `plant`'s documents written while the switch was on. */
async function legacy<T>(plant: (c: string) => Promise<T>): Promise<{ c: string } & T> {
  const c = await noteCompany(pool, [[owner, 'owner']], companies);
  const tag = c.slice(0, 6);
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,is_system_account,account_subtype)
     VALUES ($1,'RV${tag}','FX revenue','revenue','credit',true,true,'default_revenue'),($1,'VO${tag}','FX vat out','liability','credit',true,true,'vat_output'),
            ($1,'BK${tag}','FX bank','asset','debit',true,true,'bank')
     ON CONFLICT DO NOTHING`, [c]);
  await enableFxDocuments(pool, c);
  const planted = await plant(c);
  await pool.query('UPDATE companies SET fx_documents_enabled = false WHERE id = $1', [c]);
  return { c, ...planted };
}

describe('approve and post refuse a legacy foreign document while the switch is off', () => {
  it('customer invoice approve: 400, still a draft, no journal', async () => {
    const { c, id } = await legacy(async (co) => ({ id: (await plantInvoice(pool, co, owner, { currencyCode: 'USD', exchangeRate: 18.5 })).id }));
    const res = await inv.approve(owner, c, id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(messageOf(res)).toMatch(DISABLED);
    expect(await invoiceState(pool, id)).toEqual({ status: 'draft', gl_journal_entry_id: null, journals: 0 });
  });

  it('customer invoice post-to-GL of an approved one with no journal: 400, no journal', async () => {
    const { c, id } = await legacy(async (co) => ({ id: (await plantInvoice(pool, co, owner, { currencyCode: 'USD', exchangeRate: 18.5, status: 'approved' })).id }));
    const res = await callRoute(customerInvoicesGl, tokens[owner]!, c, 'POST', { invoiceId: id }, '/api/accounting/customer-invoices-gl');
    expect(res.state.statusCode).toBe(400);
    expect(messageOf(res)).toMatch(DISABLED);
    expect((await invoiceState(pool, id)).journals).toBe(0);
  });

  it('supplier bill approve, and bulk post-to-GL: 400, no journal', async () => {
    const { c, id } = await legacy(async (co) => ({ id: (await plantBill(pool, co, owner, { currencyCode: 'USD', exchangeRate: 18.5 })).id }));
    const res = await ap.approveBill(owner, c, id);
    expect(res.state.statusCode).toBe(400);
    expect(messageOf(res)).toMatch(DISABLED);
    expect(await billState(pool, id)).toMatchObject({ gl_journal_entry_id: null, journals: 0 });

    // An APPROVED legacy bill with no journal: the bulk "Post to GL" refuses it per item, before any write.
    await enableFxDocuments(pool, c);
    await pool.query("UPDATE supplier_invoices SET status = 'approved' WHERE id = $1", [id]);
    await pool.query('UPDATE companies SET fx_documents_enabled = false WHERE id = $1', [c]);
    const bulk = await ap.bulk(owner, c, 'post_gl', [id]);
    expect(JSON.stringify(bulk.state.body)).toMatch(/USD bills are not enabled for this company/);
    expect(await billState(pool, id)).toMatchObject({ gl_journal_entry_id: null, journals: 0 });
  });

  it('credit note approve: its own currency, and an invoice it is linked to, both refused', async () => {
    const own = await legacy(async (co) => {
      const note = await plantNote(pool, co, owner, 'customer');
      await pool.query("UPDATE credit_notes SET currency = 'USD' WHERE id = $1", [note.id]);
      return { id: note.id };
    });
    const r1 = await cn.approve(owner, own.c, own.id);
    expect(r1.state.statusCode).toBe(400);
    expect(messageOf(r1)).toMatch(DISABLED);
    expect((await noteState(pool, own.id)).journals).toBe(0);

    const linked = await legacy(async (co) => {
      const note = await plantNote(pool, co, owner, 'customer', { linked: true });
      await pool.query("UPDATE customer_invoices SET currency_code = 'USD', exchange_rate = 18.5 WHERE id = $1", [note.invoiceId]);
      return { id: note.id };
    });
    const r2 = await cn.approve(owner, linked.c, linked.id);
    expect(r2.state.statusCode).toBe(400);
    expect(messageOf(r2)).toMatch(DISABLED);
    expect(await noteState(pool, linked.id)).toMatchObject({ status: 'draft', journals: 0, invoice_paid: 0 });
  });
});

/** The services in a committed transaction of their own, as a request runs them. */
async function inTx<T>(c: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: owner, companyId: c, claims: {} } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

describe('settlement that picks its own documents leaves a foreign one out', () => {
  it('the open-document readers (FIFO auto-apply, bulk auto-allocate, auto_apply_unapplied) skip it', async () => {
    const { c, usd, zar, usdBill, zarBill } = await legacy(async (co) => {
      const usdInv = await plantInvoice(pool, co, owner, { currencyCode: 'USD', exchangeRate: 18.5, status: 'sent' });
      const usdB = await plantBill(pool, co, owner, { currencyCode: 'USD', exchangeRate: 18.5 });
      await pool.query("UPDATE supplier_invoices SET status = 'approved' WHERE id = $1", [usdB.id]);
      return { usd: usdInv, usdBill: usdB };
    }).then(async (x) => {
      await pool.query('UPDATE customer_invoices SET customer_id = $2, client_id = $2 WHERE id = $1', [x.usd.id, x.usd.customerId]);
      const zarInv = await plantInvoice(pool, x.c, owner, { status: 'sent' });
      await pool.query('UPDATE customer_invoices SET customer_id = $2, client_id = $2 WHERE id = $1', [zarInv.id, x.usd.customerId]);
      const zarB = await plantBill(pool, x.c, owner);
      await pool.query("UPDATE supplier_invoices SET status = 'approved', supplier_id = $2 WHERE id = $1", [zarB.id, x.usdBill.supplierId]);
      return { ...x, zar: zarInv, zarBill: zarB };
    });
    const open = await inTx(c, () => fetchOpenCustomerInvoices(c, usd.customerId, true, { forUpdate: true }));
    expect(open.map((d) => d.invoiceId)).toEqual([zar.id]);
    const bills = await inTx(c, () => fetchOpenSupplierBills(c, usdBill.supplierId, true, { forUpdate: true }));
    expect(bills.map((d) => d.invoiceId)).toEqual([zarBill.id]);
  });

  it('bulk bank allocation naming a foreign invoice skips that line', async () => {
    const { c, id } = await legacy(async (co) => ({ id: (await plantInvoice(pool, co, owner, { currencyCode: 'USD', exchangeRate: 18.5, status: 'sent' })).id }));
    const states = await inTx(c, () => fetchInvoiceStates(c, [{ kind: 'customer', invoiceId: id }]));
    expect(skipReasonForInvoice(states.get(id), id, 10)).toMatch(/foreign currency, which a rand payment cannot settle yet/);
  });

  it('a supplier payment, or a batch, naming a foreign bill: 400 before any write', async () => {
    const { c, bill } = await legacy(async (co) => {
      const b = await plantBill(pool, co, owner, { currencyCode: 'USD', exchangeRate: 18.5 });
      await pool.query("UPDATE supplier_invoices SET status = 'approved' WHERE id = $1", [b.id]);
      return { bill: b };
    });
    const pay = await callRoute(supplierPayments, tokens[owner]!, c, 'POST', {
      supplierId: bill.supplierId, paymentDate: '2026-09-15', totalAmount: 100, reference: 'FX0',
      allocations: [{ invoiceId: bill.id, amount: 100 }] }, '/api/accounting/supplier-payments');
    expect(pay.state.statusCode, JSON.stringify(pay.state.body)).toBe(400);
    expect(messageOf(pay)).toMatch(/cannot be paid: This bill is in USD, and settling a foreign-currency bill is not supported yet/);
    const batch = await callRoute(batchPayments, tokens[owner]!, c, 'POST', {
      batchDate: '2026-09-15', payments: [{ supplierId: bill.supplierId, invoiceAllocations: [{ invoiceId: bill.id, amount: 100 }] }],
    }, '/api/accounting/batch-payments');
    expect(batch.state.statusCode, JSON.stringify(batch.state.body)).toBe(400);
    expect(messageOf(batch)).toMatch(/cannot be paid: This bill is in USD, and settling a foreign-currency bill is not supported yet/);
    const counts = await pool.query(
      `SELECT (SELECT count(*)::INT FROM supplier_payments WHERE company_id = $1) AS p,
              (SELECT count(*)::INT FROM supplier_payment_batches WHERE company_id = $1) AS b`, [c]);
    expect(counts.rows[0]).toEqual({ p: 0, b: 0 });
  });
});
