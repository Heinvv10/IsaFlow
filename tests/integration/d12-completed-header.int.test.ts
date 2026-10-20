/**
 * D12 census rows 6-10 on ONE completed session over the fixture's bank account, holding a supplier payment's, a
 * customer receipt's and a payment batch's statement lines (each matched INTO it before completion):
 *  6  every reversal / void that reaches one of its lines — HTTP reverse, supplier void, receipt cancel, batch reverse,
 *     MCP reverse_bank_allocation / void_payment / void_receipt — refused with the ONE 409 ("is completed — reopen it
 *     first"; an MCP refusal over the same code). On ddc4dd355: 400 (ReconciledCashError / SupplierPaymentRefusal).
 *  7  complete it again -> 409 (was 400 "already completed"); 8 cancel -> 409 (was 400); 10 adjustment -> 409 (was 400).
 *  9  reopen is the way back: after it, unmatch works.
 * Every refusal writes nothing: the account's lines, the header and the company's journals read back unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@/lib/neon';
import supplierPaymentsAction from '../../pages/api/accounting/supplier-payments-action';
import customerPaymentsAction from '../../pages/api/accounting/customer-payments-action';
import batchPaymentsAction from '../../pages/api/accounting/batch-payments-action';
import { reverseBankAllocationTool } from '@/lib/mcp/tools/writeBankAllocate';
import { voidPaymentTool, voidReceiptTool } from '@/lib/mcp/tools/writeVoidPayments';
import { isRefusalCoded } from '@/lib/mcp/tools/toolHelpers';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { teardown, type Ctx } from './d8-r4-helpers';
import { bankLegOf, chainDoc, clearExtras, setupWithUser, type ChainDoc } from './d10-helpers';
import { call, cleanup, lineOf, matchInto, routes, snapshot, startSession, type Route } from './d12-helpers';

let c: Ctx;
let token = '';
let rec = '';
let docs: Record<'ap' | 'ar' | 'batch', ChainDoc>;
const REFUSAL = /is completed — reopen it first/;
const mcpCtx = () => ({ companyId: c.fx.companyId, userId: c.fx.userId, scopes: ['write:invoices', 'write:post', 'write:bank-tx'],
  companyRole: 'owner', tokenJti: null, oauthAppId: null });
const lineOfDoc = (d: ChainDoc) => d.lines.get(0)!;

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D12: a completed reconciliation\'s header and cash', () => {
  beforeAll(async () => {
    assertNotProductionDb('D12 header');
    ({ c, token } = await setupWithUser('D12H'));
    docs = { ap: await chainDoc(c, 'ap', 0, [0]), ar: await chainDoc(c, 'ar', 0, [0]), batch: await chainDoc(c, 'batch', 0, [0]) };
    rec = await startSession(c, token, c.fx.bankAccountId);
    for (const d of Object.values(docs)) {
      await matchInto(c, token, rec, { bt: lineOfDoc(d), jl: await bankLegOf(c, d.chain[0]!) });
    }
    const done = await call(c, token, routes.recon, { action: 'complete', reconciliationId: rec });
    if (done.status !== 200) throw new Error(`complete: ${JSON.stringify(done)}`);
    for (const d of Object.values(docs)) expect((await lineOf(lineOfDoc(d))).status).toBe('reconciled');
  }, 180000);
  afterAll(async () => { await cleanup(c); await clearExtras(c); await teardown(c); }, 120000);

  async function refused(route: Route, body: Record<string, unknown>) {
    const before = await snapshot(c, c.fx.bankAccountId, rec);
    const out = await call(c, token, route, body);
    expect(out.status, JSON.stringify(out)).toBe(409);
    expect(out.body).toMatch(REFUSAL);
    expect(await snapshot(c, c.fx.bankAccountId, rec), 'nothing written').toEqual(before);
  }
  async function mcpRefused(run: () => Promise<unknown>) {
    const before = await snapshot(c, c.fx.bankAccountId, rec);
    let err: unknown = null;
    let result: unknown = null;
    try { result = await inTx(c.fx, run); } catch (e) { err = e; }
    expect(err, `a thrown refusal (the registry rolls back and answers its message), got ${JSON.stringify(result)}`).not.toBeNull();
    expect(isRefusalCoded(err), String(err)).toBe(true);
    expect((err as Error).message).toMatch(REFUSAL);
    expect(await snapshot(c, c.fx.bankAccountId, rec), 'nothing written').toEqual(before);
  }

  it('row 6: HTTP reverse of a reconciled line -> 409', () =>
    refused(routes.tx, { action: 'reverse', bankTransactionId: lineOfDoc(docs.ap) }), 60000);

  it('row 6: supplier payment void (supplier-payments-action) -> 409', () =>
    refused(supplierPaymentsAction as Route, { action: 'void', paymentId: docs.ap.payId }), 60000);

  it('row 6: customer receipt cancel (customer-payments-action) -> 409', () =>
    refused(customerPaymentsAction as Route, { action: 'cancel', paymentId: docs.ar.payId, reason: 'd12' }), 60000);

  it('row 6: batch reverse (batch-payments-action) -> 409', () =>
    refused(batchPaymentsAction as Route, { action: 'reverse', id: docs.batch.docId }), 60000);

  it('row 6: MCP reverse_bank_allocation -> refusal', () => mcpRefused(() => reverseBankAllocationTool.handler(
    { transaction_id: lineOfDoc(docs.ap), idempotency_key: randomUUID() }, mcpCtx() as never)), 60000);

  it('row 6: MCP void_payment -> refusal', () => mcpRefused(() => voidPaymentTool.handler(
    { payment_id: docs.ap.payId, idempotency_key: randomUUID() }, mcpCtx() as never)), 60000);

  it('row 6: MCP void_receipt -> refusal', () => mcpRefused(() => voidReceiptTool.handler(
    { receipt_id: docs.ar.payId, idempotency_key: randomUUID() }, mcpCtx() as never)), 60000);

  it('row 7: complete it again -> 409, header untouched', () =>
    refused(routes.recon, { action: 'complete', reconciliationId: rec }), 60000);

  it('row 8: cancel -> 409, no line released', () => refused(routes.recon, { action: 'cancel', reconciliationId: rec }), 60000);

  it('row 10: adjustment -> 409, no journal posted', () => refused(routes.recon, {
    action: 'adjustment', reconciliationId: rec, bankAccountId: c.fx.bankAccountId, contraAccountId: c.acct.expense,
    amount: 12.34, description: 'd12' }), 60000);

  it('row 9: reopen is the way back — afterwards a line of it can be unmatched', async () => {
    const out = await call(c, token, routes.recon, { action: 'reopen', reconciliationId: rec, reason: 'd12 test' });
    expect(out.status, JSON.stringify(out)).toBe(200);
    expect(((await sql`SELECT status FROM bank_reconciliations WHERE id = ${rec}::UUID`) as { status: string }[])[0]!.status)
      .toBe('in_progress');
    const un = await call(c, token, routes.tx, { action: 'unmatch', bankTransactionId: lineOfDoc(docs.ap) });
    expect(un.status, JSON.stringify(un)).toBe(200);
    expect((await lineOf(lineOfDoc(docs.ap))).status).toBe('imported');
  }, 60000);
});
