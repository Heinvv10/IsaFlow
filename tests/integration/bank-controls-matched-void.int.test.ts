/**
 * Bank controls step 2 (blind review #684 round 3, LOW-A): a supplier payment
 * processed by a, whose journal's bank leg a statement line is MATCHED to, is
 * a bank allocation (round 1's rule). Its own void reverses that journal and
 * frees the line, so under supplier_payment enforcement it is judged exactly
 * as the bank line's reverse is: the payment's maker may not void it (403),
 * an agent may not (MCP void_payment), another member does — audited. With
 * enforcement off the void is unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import supplierPaymentsAction from '../../pages/api/accounting/supplier-payments-action';
import { voidPaymentTool } from '../../src/lib/mcp/tools/writeVoidPayments';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { payRoutes, plantBatch as plantPaymentBatch, plantPayment } from './r035-pr5.helpers';
import {
  actionRoute, bankCompany, cleanupBankControlsA, enforce, lineStatus, mcpCaller, PAY_TYPES, plantBatch, plantLine, refusalOf,
  type BankCompany,
} from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
const mcp = mcpCaller(pool, [voidPaymentTool]);

beforeAll(async () => { a = await createUser(pool, tokens); b = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a, b]);
});

/** a processes a R1 150 payment; b matches a statement line to its bank leg; then `types` are enforced. */
async function matchedPayment(types: string[]): Promise<{ f: BankCompany; paymentId: string; line: string }> {
  const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
  const pay = await plantPayment(pool, f.c, a, f.bank);
  const routes = payRoutes(tokens);
  for (const step of ['approve', 'process']) {
    const res = await routes.payment(a, f.c, step, pay.id);
    expect(res.state.statusCode, `${step}: ${JSON.stringify(res.state.body)}`).toBe(200);
  }
  const leg = (await pool.query(
    `SELECT jl.id FROM supplier_payments sp JOIN gl_journal_lines jl ON jl.journal_entry_id = sp.gl_journal_entry_id
     WHERE sp.id = $1 AND jl.gl_account_id = $2`, [pay.id, f.bank])).rows[0].id as string;
  const line = await plantLine(pool, f, await plantBatch(pool, f, null), -1150);
  const matched = await actionRoute(tokens)(b, f.c, { action: 'match', bankTransactionId: line, journalLineId: leg });
  expect(matched.state.statusCode, JSON.stringify(matched.state.body)).toBe(200);
  await enforce(pool, f.c, a, types);
  return { f, paymentId: pay.id, line };
}
const voidAs = (user: string, c: string, paymentId: string) => callRoute(supplierPaymentsAction as never, tokens[user]!, c, 'POST',
  { action: 'void', paymentId }, '/api/accounting/supplier-payments-action');
const status = async (paymentId: string) =>
  (await pool.query('SELECT status FROM supplier_payments WHERE id = $1', [paymentId])).rows[0].status as string;

describe('the void of a payment a statement line is matched to', () => {
  it("the payment's maker is refused 403, nothing written; another member voids it, line freed, audited", async () => {
    const { f, paymentId, line } = await matchedPayment(PAY_TYPES);
    expect(refusalOf(await voidAs(a, f.c, paymentId))).toMatchObject({ status: 403, reason: 'ALLOCATOR_MAY_NOT_REVERSE' });
    expect([await status(paymentId), await lineStatus(pool, line)]).toEqual(['processed', 'matched']);
    const ok = await voidAs(b, f.c, paymentId);
    expect(ok.state.statusCode, JSON.stringify(ok.state.body)).toBe(200);
    expect([await status(paymentId), await lineStatus(pool, line)]).toEqual(['cancelled', 'imported']);
    const audit = (await pool.query(
      "SELECT user_id, entity_id::TEXT AS line, changes->'metadata'->>'armType' AS arm FROM audit_log WHERE company_id = $1 AND action = 'reverse'",
      [f.c])).rows;
    expect(audit).toEqual([{ user_id: b, line, arm: 'supplier_payment' }]);
  });

  it('an agent is refused through MCP void_payment, nothing written', async () => {
    const { f, paymentId, line } = await matchedPayment(PAY_TYPES);
    const res = await mcp(b, f.c, 'void_payment', { payment_id: paymentId, idempotency_key: `bc-a-void-${paymentId}` });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/an agent or a job cannot/);
    expect([await status(paymentId), await lineStatus(pool, line)]).toEqual(['processed', 'matched']);
  });

  it('enforcement off: the maker voids it as before', async () => {
    const { f, paymentId, line } = await matchedPayment([]);
    expect((await voidAs(a, f.c, paymentId)).state.statusCode).toBe(200);
    expect(await lineStatus(pool, line)).toBe('imported');
  });

  it('batch-payments-action reverse of a batch a statement line is matched to: its maker 403 with the reason, nothing written', async () => {
    const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
    const batch = await plantPaymentBatch(pool, f.c, a, f.bank, [1150]);
    const routes = payRoutes(tokens);
    for (const step of ['approve', 'process']) {
      const res = await routes.batch(a, f.c, step, batch.id);
      expect(res.state.statusCode, `${step}: ${JSON.stringify(res.state.body)}`).toBe(200);
    }
    const leg = (await pool.query(
      `SELECT jl.id FROM supplier_payment_batches sb JOIN gl_journal_lines jl ON jl.journal_entry_id = sb.gl_journal_entry_id
       WHERE sb.id = $1 AND jl.gl_account_id = $2`, [batch.id, f.bank])).rows[0].id as string;
    const line = await plantLine(pool, f, await plantBatch(pool, f, null), -1150);
    expect((await actionRoute(tokens)(b, f.c, { action: 'match', bankTransactionId: line, journalLineId: leg })).state.statusCode).toBe(200);
    await enforce(pool, f.c, a, PAY_TYPES);
    const refused = await routes.batch(a, f.c, 'reverse', batch.id);
    expect(refusalOf(refused), JSON.stringify(refused.state.body)).toMatchObject({ status: 403, reason: 'ALLOCATOR_MAY_NOT_REVERSE' });
    const state = async () => [(await pool.query('SELECT status FROM supplier_payment_batches WHERE id = $1', [batch.id])).rows[0].status,
      await lineStatus(pool, line)];
    expect(await state()).toEqual(['processed', 'matched']);
    expect((await routes.batch(b, f.c, 'reverse', batch.id)).state.statusCode).toBe(200);
  });
});
