/**
 * Intercompany P4-E (j).3, the shared-layer guard: with the dark flag ON for the payer, a bill slotted in an ACTIVE link is settled from the
 * payer side's LOAN account only by "Clear against the intercompany loan" (its permit and its author label). MCP settle_by_contra (ap, its dry
 * run too), a plain supplier payment from the loan account (create, approve, then process) and applying a processed loan-account payment to
 * the bill are refused with "use Clear against the intercompany loan", nothing posted and nothing sent. The same paths stay open for an
 * unlinked bill, another account, and with the flag off (behaviour unchanged; nothing is sent).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { McpRegistry } from '../../../src/lib/mcp/registry';
import { settleByContraTool } from '../../../src/lib/mcp/tools/writeSettleByContra';
import { createSupplierPayment } from '../../../src/modules/accounting/services/ap/supplierPaymentService';
import actionRoute from '../../../pages/api/accounting/supplier-payments-action';
import allocationsRoute from '../../../pages/api/accounting/supplier-allocations';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { callRoute } from '../r035-approval.helpers';
import { acct, co, party, tokens, U, wipeConnections } from './intercompany.helpers';
import { asService, mirrorCleanup } from './mirror.helpers';
import { clearPayments, plantPaid } from './allocation.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import { clearConnect, errorText, payer, payerSetup, plantBill } from './payer-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';
const GUARD = /use Clear against the intercompany loan/;

beforeAll(() => payerSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await clearConnect(pool);
});

const registry = new McpRegistry();
registry.register(settleByContraTool);
const settle = (bill: string, contra: string, extra: Record<string, unknown> = {}) => asService(pool, U.b, co.B, () => registry.call('settle_by_contra', {
  subledger: 'ap', document_id: bill, contra_account_id: contra, amount: 1150, reason: 'netted against the group loan',
  settlement_date: '2026-09-10', idempotency_key: crypto.randomUUID(), ...extra,
}, { userId: U.b, companyId: co.B, scopes: ['write:invoices', 'write:post'], companyRole: 'owner', tokenJti: 'p4e-guard', oauthAppId: null }));
const text = (res: { content: { text: string }[] }) => res.content[0]!.text;

/** A draft supplier payment of B from `account` for `bill`, approved through the real action route. */
async function approvedPayment(bill: string, account: string): Promise<string> {
  const p = await asService(pool, U.b, co.B, () => createSupplierPayment(co.B, {
    supplierId: party.bSupplier, paymentDate: '2026-09-10', totalAmount: 1150, paymentMethod: 'eft', bankAccountId: account,
    allocations: [{ invoiceId: bill, amount: 1150 }],
  }, U.b));
  const approved = await callRoute(actionRoute, tokens[U.b]!, co.B, 'POST', { action: 'approve', paymentId: p.id }, '/api/accounting/supplier-payments-action');
  expect(approved.state.statusCode, errorText(approved)).toBe(200);
  return p.id;
}
const processPayment = (id: string) => callRoute(actionRoute, tokens[U.b]!, co.B, 'POST', { action: 'process', paymentId: id }, '/api/accounting/supplier-payments-action');

describe('MCP settle_by_contra (ap)', () => {
  it('a linked bill against the payer loan account: refused (the dry run too), nothing posted or sent', async () => {
    const b = await plantBill(pool, conn);
    const before = [await payer.journals(pool), await payer.payments(pool), await payer.messages(pool)];
    const dry = await settle(b.bill, acct.bLoan, { dry_run: true });
    expect(text(dry)).toMatch(GUARD);
    const res = await settle(b.bill, acct.bLoan);
    expect(text(res)).toMatch(GUARD);
    expect([await payer.journals(pool), await payer.payments(pool), await payer.messages(pool)]).toEqual(before);
    expect(await payer.open(pool, b.bill)).toBeCloseTo(1150, 2);
  });

  it('an unlinked bill against the loan account settles as before (and sends nothing)', async () => {
    const lone = await plantBill(pool, conn, { link: false });
    const res = await settle(lone.bill, acct.bLoan);
    expect(text(res)).not.toMatch(GUARD);
    expect(await payer.open(pool, lone.bill)).toBeCloseTo(0, 2);
    expect(await payer.messages(pool)).toBe(0);
  });

  it('the flag off for the payer: unchanged behaviour, the linked bill settles and nothing is sent', async () => {
    const b = await plantBill(pool, conn);
    await setLoanClearing(pool, [co.B], false);
    try {
      const res = await settle(b.bill, acct.bLoan);
      expect(text(res)).not.toMatch(GUARD);
      expect(await payer.open(pool, b.bill)).toBeCloseTo(0, 2);
      expect(await payer.messages(pool)).toBe(0);
    } finally {
      await setLoanClearing(pool, [co.B], true);
    }
  });
});

describe('a plain supplier payment from the loan account', () => {
  it('processing it on a linked bill is refused (400, before the posting): the payment stays approved, no journal, no message', async () => {
    const b = await plantBill(pool, conn);
    const id = await approvedPayment(b.bill, acct.bLoan);
    const journals = await payer.journals(pool);
    const res = await processPayment(id);
    expect(res.state.statusCode).toBe(400);
    expect(errorText(res)).toMatch(GUARD);
    expect(await payer.journals(pool)).toBe(journals);
    expect((await pool.query('SELECT status FROM supplier_payments WHERE id = $1', [id])).rows[0].status).toBe('approved');
    expect(await payer.messages(pool)).toBe(0);
  });

  it('from another (non-loan) account it processes as before', async () => {
    const b = await plantBill(pool, conn);
    const other = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active, account_subtype)
       VALUES ($1, $2, $3, 'IC B other liability', 'liability', 'credit', true, 'other_current_liability')`, [other, co.B, `OL${other.slice(0, 6)}`]);
    const id = await approvedPayment(b.bill, other);
    const res = await processPayment(id);
    expect(res.state.statusCode, errorText(res)).toBe(200);
  });
});

describe('applying a processed loan-account payment to a linked bill', () => {
  it('is refused (400), nothing applied or sent', async () => {
    const b = await plantBill(pool, conn);
    const paid = await plantPaid(pool, b.bill, { leg: acct.bLoan, allocate: false });
    const res = await callRoute(allocationsRoute, tokens[U.b]!, co.B, 'POST', { paymentId: paid.payment, allocations: [{ invoiceId: b.bill, amount: 1150 }] },
      '/api/accounting/supplier-allocations');
    expect(res.state.statusCode).toBe(400);
    expect(errorText(res)).toMatch(GUARD);
    expect(Number((await pool.query('SELECT count(*)::int AS n FROM payment_allocations WHERE payment_id = $1', [paid.payment])).rows[0].n)).toBe(0);
    expect(await payer.messages(pool)).toBe(0);
  });
});
