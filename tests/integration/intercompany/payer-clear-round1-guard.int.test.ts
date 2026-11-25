/**
 * Intercompany P4-E, fix round 1: the shared-layer guard's scope and its dry runs. F: only a link on an ACTIVE LOAN connection makes the payer's
 * loan account E's alone (the only connection the sender sends for, and the only one E clears on): on a cash or revoked connection a plain
 * payment from that account processes as before, so the bill is not stranded. O: MCP apply_payment_to_supplier_invoice from a bank line runs the
 * guard before its dry run and before its first write (dry-run parity): a line on the payer's loan account for a linked bill is refused both ways.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { McpRegistry } from '../../../src/lib/mcp/registry';
import { applyPaymentToSupplierInvoiceTool } from '../../../src/lib/mcp/tools/writeApplySupplierPayment';
import { createSupplierPayment } from '../../../src/modules/accounting/services/ap/supplierPaymentService';
import actionRoute from '../../../pages/api/accounting/supplier-payments-action';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { callRoute } from '../r035-approval.helpers';
import { acct, co, party, tokens, U, wipeConnections, withoutTrigger } from './intercompany.helpers';
import { asService, mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { clearConnect, errorText, payer, payerSetup, plantBill } from './payer-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';
const GUARD = /use Clear against the intercompany loan/;

beforeAll(() => payerSetup(pool), 60000);
afterAll(async () => {
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [[co.A, co.B, co.C]]);
  await clearPayments(pool);
  await mirrorCleanup(pool);
}, 60000);
beforeEach(async () => {
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [[co.A, co.B, co.C]]);
  await clearPayments(pool);
  await wipeConnections(pool);
});

const action = (body: Record<string, unknown>) => callRoute(actionRoute, tokens[U.b]!, co.B, 'POST', body, '/api/accounting/supplier-payments-action');

/** A supplier payment of B from the loan account for `bill`, approved, then processed through the real action route. */
async function payFromLoan(bill: string) {
  const p = await asService(pool, U.b, co.B, () => createSupplierPayment(co.B, {
    supplierId: party.bSupplier, paymentDate: '2026-09-10', totalAmount: 1150, paymentMethod: 'eft', bankAccountId: acct.bLoan,
    allocations: [{ invoiceId: bill, amount: 1150 }],
  }, U.b));
  expect((await action({ action: 'approve', paymentId: p.id })).state.statusCode).toBe(200);
  return action({ action: 'process', paymentId: p.id });
}

describe('F: the guard covers active LOAN connections only', () => {
  it('a cash connection: a payment from the account named as the loan account processes (nothing is sent)', async () => {
    conn = await clearConnect(pool, { mode: 'cash' });
    const b = await plantBill(pool, conn);
    const res = await payFromLoan(b.bill);
    expect(res.state.statusCode, errorText(res)).toBe(200);
    expect(await payer.open(pool, b.bill)).toBeCloseTo(0, 2);
    expect(await payer.messages(pool)).toBe(0);
  });

  it('a revoked connection (the link left active): the same', async () => {
    conn = await clearConnect(pool);
    const b = await plantBill(pool, conn);
    await withoutTrigger(pool, 'intercompany_connections', 'trg_intercompany_connections_guard', (q) => q.query(
      "UPDATE intercompany_connections SET status = 'revoked', revoked_at = now(), revoked_by = $2 WHERE id = $1", [conn, U.ab]));
    const res = await payFromLoan(b.bill);
    expect(res.state.statusCode, errorText(res)).toBe(200);
    expect(await payer.messages(pool)).toBe(0);
  });

  it('an active loan connection: still refused', async () => {
    conn = await clearConnect(pool);
    const b = await plantBill(pool, conn);
    const res = await payFromLoan(b.bill);
    expect(res.state.statusCode).toBe(400);
    expect(errorText(res)).toMatch(GUARD);
  });
});

describe('O: MCP apply from a bank line on the loan account', () => {
  const registry = new McpRegistry();
  registry.register(applyPaymentToSupplierInvoiceTool);
  const ctx = { userId: U.b, companyId: co.B, scopes: ['write:invoices', 'write:post'], companyRole: 'owner', tokenJti: 'p4e-r1', oauthAppId: null };
  const applyLine = (line: string, bill: string, dry: boolean) => asService(pool, U.b, co.B, () => registry.call('apply_payment_to_supplier_invoice', {
    bank_transaction_id: line, allocations: [{ invoice_id: bill, amount: 1150 }], dry_run: dry, idempotency_key: crypto.randomUUID(),
  }, { ...ctx, userId: U.b, companyId: co.B }));
  const text = (res: { content: { text: string }[] }) => res.content[0]!.text;

  it('the dry run and the live call are refused before any write, nothing posted or sent', async () => {
    conn = await clearConnect(pool);
    const b = await plantBill(pool, conn);
    const line = (await pool.query(
      `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status)
       VALUES ($1, $2, DATE '2026-09-10', -1150, 'IC loan line', 'imported') RETURNING id`, [co.B, acct.bLoan])).rows[0].id as string;
    const before = [await payer.journals(pool), await payer.payments(pool), await payer.messages(pool)];
    expect(text(await applyLine(line, b.bill, true))).toMatch(GUARD);
    expect(text(await applyLine(line, b.bill, false))).toMatch(GUARD);
    expect([await payer.journals(pool), await payer.payments(pool), await payer.messages(pool)]).toEqual(before);
    expect(await payer.open(pool, b.bill)).toBeCloseTo(1150, 2);
  });
});
