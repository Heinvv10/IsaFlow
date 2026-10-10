/**
 * BREAKER #684 ROUND 2 — R2-4. A bank-first settlement's undo (R-127: unapply,
 * then void the fully unapplied settlement payment) REVERSES the provisional
 * bank allocation and returns the line to 'imported'
 * (ap/provisionalSettlementVoid). Round 1 gated Dismiss — the other reversal of
 * a provisional — but this one never asks bankReversalGate: under
 * manual_journal enforcement the person who made the provisional allocation
 * reverses it themselves through supplier-payments-action `void`, and an AGENT
 * through MCP void_payment, with no audit row (decision 4).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supplierPaymentsAction from '../../pages/api/accounting/supplier-payments-action';
import { voidPaymentTool } from '@/lib/mcp/tools/writeVoidPayments';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { unapplySupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentUnapply';
import {
  btState, company, inTx, jeState, paymentsFor, pool, seedDoc, seedInvoice, seedProvisional, useR127Fixture, user,
} from './r127-double-booking.helpers';
import { callRoute as routeAs, sign } from './r035-approval.helpers';

useR127Fixture();
const other = crypto.randomUUID();

beforeAll(async () => {
  // A second admin, so the allocator is not the sole approver.
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [other, `${other}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, other]);
});
afterAll(async () => {
  await pool.query('DELETE FROM approval_enforcement WHERE company_id = $1', [company]);
  await pool.query('DELETE FROM audit_log WHERE company_id = $1', [company]);
  await pool.query('DELETE FROM company_users WHERE user_id = $1', [other]);
  await pool.query('DELETE FROM users WHERE id = $1', [other]);
});

/** Settled (before enforcement), unapplied, then manual_journal enforced. The provisional's created_by is `user`. */
async function unappliedSettlement(total: number) {
  const doc = await seedDoc();
  const { je, bt } = await seedProvisional({ totalAmount: total, evidencedBy: doc });
  const invoiceId = await seedInvoice({ documentId: doc, totalAmount: total });
  await inTx(() => approveSupplierInvoice(company, invoiceId, user));
  const [p] = await paymentsFor(bt, invoiceId);
  await inTx(() => unapplySupplierPayment(company, { paymentId: p!.id }, user));
  await pool.query(`INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1,'manual_journal',$2)
    ON CONFLICT DO NOTHING`, [company, other]);
  return { je, bt, paymentId: p!.id };
}
const reverses = async () => Number((await pool.query(
  "SELECT count(*) FROM audit_log WHERE company_id = $1 AND action = 'reverse'", [company])).rows[0].count);

describe('the R-127 settlement undo reverses a provisional bank allocation around the reversal gate', () => {
  it('the allocator voids it through supplier-payments-action (expected 403 ALLOCATOR_MAY_NOT_REVERSE)', async () => {
    const s = await unappliedSettlement(611.30);
    // A person in their own session (session_id in the claims), the allocator of the provisional.
    const res = (await routeAs(supplierPaymentsAction as never, await sign(user), company, 'POST', { action: 'void', paymentId: s.paymentId },
      '/api/accounting/supplier-payments-action')).state;
    expect({ status: res.statusCode, provisionalReversed: (await jeState(s.je)).reversed_at != null, line: (await btState(s.bt)).status })
      .toEqual({ status: 403, provisionalReversed: false, line: 'matched' });
  });

  it('an agent voids it through MCP void_payment (expected refused under enforcement)', async () => {
    const s = await unappliedSettlement(612.40);
    const ctx = { companyId: company, userId: other, scopes: ['write:invoices', 'write:post'], tokenJti: null, oauthAppId: null };
    const out = await inTx(() => voidPaymentTool.handler({ payment_id: s.paymentId, idempotency_key: crypto.randomUUID() }, ctx as never))
      .then((o) => ({ isError: o.isError === true }), () => ({ isError: true }));
    expect({ ...out, provisionalReversed: (await jeState(s.je)).reversed_at != null, audits: await reverses() })
      .toEqual({ isError: true, provisionalReversed: false, audits: 0 });
  });

  it('FIXED: another member undoes it — the provisional reversed, the line freed, one audit row', async () => {
    const s = await unappliedSettlement(613.50);
    const res = (await routeAs(supplierPaymentsAction as never, await sign(other), company, 'POST', { action: 'void', paymentId: s.paymentId },
      '/api/accounting/supplier-payments-action')).state;
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect({ provisionalReversed: (await jeState(s.je)).reversed_at != null, line: (await btState(s.bt)).status, audits: await reverses() })
      .toEqual({ provisionalReversed: true, line: 'imported', audits: 1 });
  });
});
