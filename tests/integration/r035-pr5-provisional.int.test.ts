/**
 * R-035 PR5 round 2 (blind LOW): approving or posting a bill whose slip
 * evidences a bank-first provisional settles the bill from that provisional's
 * bank line — a 'processed' supplier payment (R-127). From a HAND-KEYED line
 * that is a payment on a user's say-so (D2), so under supplier_payment
 * enforcement with a matching rule it is refused 409 from reads, in the claim,
 * before the approval's first write: nothing is written. It used to reach the
 * 867 backstop only after the bill's journal, and fail as a 500. A line from an
 * imported statement is evidence and settles as before; so does any line when
 * enforcement is off.
 */
import { afterAll, describe, expect, it } from 'vitest';
import supplierInvoicesAction from '../../pages/api/accounting/supplier-invoices-action';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { ApprovalRequiredError } from '@/modules/accounting/services/gl/approvalGate';
import { plantRule } from './r035-approval.helpers';
import {
  callRoute, company, companySnapshot, inTx, pool, seedDoc, seedInvoice, seedProvisional, useR127Fixture, user,
} from './r127-double-booking.helpers';

useR127Fixture();
// Registered after the fixture, so it runs before the fixture's purge (hooks unwind as a stack).
afterAll(async () => {
  await pool.query('DELETE FROM approval_enforcement WHERE company_id = $1', [company]);
  await pool.query('DELETE FROM approval_rules WHERE company_id = $1', [company]);
});

const approveViaRoute = (invoiceId: string) => callRoute(
  supplierInvoicesAction, '/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId });

/** Every supplier payment over R100 needs an owner; enforcement on for both coupled payment types. */
async function enforce(on: boolean): Promise<void> {
  await pool.query('DELETE FROM approval_enforcement WHERE company_id = $1', [company]);
  await pool.query('DELETE FROM approval_rules WHERE company_id = $1', [company]);
  if (!on) return;
  await plantRule(pool, company, 'owner', { documentType: 'supplier_payment', operator: 'greater_than', value: 100 });
  for (const type of ['supplier_payment', 'payment_batch']) {
    await pool.query('INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1,$2,$3)', [company, type, user]);
  }
}

/** A provisional evidenced by a fresh slip, its line keyed by hand or imported, and a draft bill from the slip. */
async function slipBill(total: number, provenance: 'manual' | 'import', status?: string) {
  const doc = await seedDoc();
  const { bt } = await seedProvisional({ totalAmount: total, evidencedBy: doc });
  if (provenance === 'import') {
    await pool.query('UPDATE bank_transactions SET import_batch_id = $2 WHERE id = $1', [bt, crypto.randomUUID()]);
  }
  return seedInvoice({ documentId: doc, totalAmount: total, ...(status ? { status } : {}) });
}

const settledPayments = async (invoiceId: string) => Number((await pool.query(
  `SELECT count(*)::INT AS n FROM supplier_payments sp JOIN payment_allocations pa ON pa.payment_id = sp.id
   WHERE sp.company_id = $1 AND pa.invoice_id = $2 AND sp.settles_provisional_je_id IS NOT NULL`,
  [company, invoiceId])).rows[0].n);

describe('a bill settled from a hand-keyed provisional line, under supplier_payment enforcement', () => {
  it('approve is refused 409 before any write: the bill stays a draft, no journal, no payment', async () => {
    await enforce(true);
    const invoiceId = await slipBill(611.80, 'manual');
    const before = await companySnapshot(invoiceId);
    const res = await approveViaRoute(invoiceId);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/keyed by hand is no evidence/);
    expect(await companySnapshot(invoiceId)).toEqual(before);
  });

  it('Post to GL of an approved bill is refused from reads too (an ApprovalRequiredError, not the backstop)', async () => {
    await enforce(true);
    const invoiceId = await slipBill(612.95, 'manual', 'approved');
    const before = await companySnapshot(invoiceId);
    const err = await inTx(() => postSupplierInvoiceToGL(company, invoiceId, user)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalRequiredError);
    expect(await companySnapshot(invoiceId)).toEqual(before);
  });

  it('a line from an imported statement is evidence: approved and settled under enforcement', async () => {
    await enforce(true);
    const invoiceId = await slipBill(614.10, 'import');
    const res = await approveViaRoute(invoiceId);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(await settledPayments(invoiceId)).toBe(1);
  });

  it('with enforcement off, a hand-keyed line settles as before', async () => {
    await enforce(false);
    const invoiceId = await slipBill(615.25, 'manual');
    const res = await approveViaRoute(invoiceId);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(await settledPayments(invoiceId)).toBe(1);
  });
});
