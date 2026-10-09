/**
 * Bank controls step 2 (blind review #684 MEDIUM-1, LOW-4): every route whose
 * call graph can raise a bank-control refusal answers it 403 with its reason,
 * not a 500 or a blanket 400 — the payment void and the receipt/refund cancel,
 * which reverse a bank-linked document through the choke point — and the
 * allocator is recognised case-insensitively, like the importer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import supplierPaymentsAction from '../../pages/api/accounting/supplier-payments-action';
import customerPaymentsAction from '../../pages/api/accounting/customer-payments-action';
import { reverseReconciledTransaction } from '../../src/modules/accounting/services/bank/bankAllocationService';
import { undoRun } from '../../src/modules/accounting/services/bank/autoPostUndoService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import {
  actionRoute, asToken, bankCompany, cleanupBankControlsA, enforce, lineStatus, PAY_TYPES, plantBatch, plantLine, refusalOf,
  type BankCompany,
} from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
let act: ReturnType<typeof actionRoute>;

beforeAll(async () => { a = await createUser(pool, tokens); b = await createUser(pool, tokens); act = actionRoute(tokens); });
afterAll(() => cleanupBankControlsA(pool, companies, [a, b]));

/** A line of a legacy batch allocated by a with `body`, then `types` enforced. */
async function allocated(types: string[], body: (f: BankCompany) => Record<string, unknown>, amount = -1500) {
  const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
  const line = await plantLine(pool, f, await plantBatch(pool, f, null), amount);
  const res = await act(a, f.c, { action: 'allocate', bankTransactionId: line, ...body(f) });
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  await enforce(pool, f.c, a, types);
  return { f, line };
}

describe('the routes that reverse a bank-linked document answer the refusal 403', () => {
  it('supplier-payments-action void: the allocator is refused 403 with its reason, nothing written; another member voids', async () => {
    const { f, line } = await allocated(PAY_TYPES, (x) => ({ allocationType: 'supplier', entityId: x.supplier }));
    const paymentId = (await pool.query('SELECT id FROM supplier_payments WHERE company_id = $1', [f.c])).rows[0].id as string;
    const voidAs = (user: string) => callRoute(supplierPaymentsAction as never, tokens[user]!, f.c, 'POST',
      { action: 'void', paymentId }, '/api/accounting/supplier-payments-action');
    expect(refusalOf(await voidAs(a))).toMatchObject({ status: 403, reason: 'ALLOCATOR_MAY_NOT_REVERSE' });
    expect([await lineStatus(pool, line),
      (await pool.query('SELECT status FROM supplier_payments WHERE id = $1', [paymentId])).rows[0].status]).toEqual(['allocated', 'processed']);
    const ok = await voidAs(b);
    expect(ok.state.statusCode, JSON.stringify(ok.state.body)).toBe(200);
    expect(await lineStatus(pool, line)).toBe('imported');
  });

  it('customer-payments-action cancel of a customer REFUND (money out): the allocator is refused 403; another member cancels', async () => {
    const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
    const batch = await plantBatch(pool, f, null);
    const receipt = await plantLine(pool, f, batch, 1000); // credit on account to refund from
    expect((await act(b, f.c, { action: 'allocate', bankTransactionId: receipt, allocationType: 'customer', entityId: f.customer }))
      .state.statusCode).toBe(200);
    const refund = await plantLine(pool, f, batch, -400);
    expect((await act(a, f.c, { action: 'allocate', bankTransactionId: refund, allocationType: 'customer', entityId: f.customer }))
      .state.statusCode).toBe(200);
    await enforce(pool, f.c, a, ['manual_journal']);
    const paymentId = (await pool.query( // the refund document names its bank line (customerRefundDocument)
      'SELECT id FROM customer_payments WHERE company_id = $1 AND bank_reference = $2', [f.c, refund])).rows[0].id as string;
    const cancelAs = (user: string) => callRoute(customerPaymentsAction as never, tokens[user]!, f.c, 'POST',
      { action: 'cancel', paymentId, reason: 'BC test' }, '/api/accounting/customer-payments-action');
    expect(refusalOf(await cancelAs(a))).toMatchObject({ status: 403, reason: 'ALLOCATOR_MAY_NOT_REVERSE' });
    expect(await lineStatus(pool, refund)).toBe('allocated');
    const ok = await cancelAs(b);
    expect(ok.state.statusCode, JSON.stringify(ok.state.body)).toBe(200);
    expect(await lineStatus(pool, refund)).toBe('imported');
  });
});

describe('the allocator is recognised whatever the letter case of the id', () => {
  it('reverseReconciledTransaction and undoRun refuse the allocator named in upper case', async () => {
    const { f, line } = await allocated(['manual_journal'], (x) => ({ allocationType: 'account', contraAccountId: x.expA }));
    const person = <T>(fn: () => Promise<T>) => asToken(pool, a, f.c, fn, { session: true });
    await expect(person(() => reverseReconciledTransaction(f.c, line, a.toUpperCase())))
      .rejects.toMatchObject({ code: 'ALLOCATOR_MAY_NOT_REVERSE' });
    const runId = (await pool.query(
      `INSERT INTO bank_auto_post_runs(company_id, source, min_confidence, amount_cap, posted_count, created_by)
       VALUES($1,'categorization',0.9,0,1,$2) RETURNING id`, [f.c, a])).rows[0].id as string;
    await pool.query('UPDATE bank_transactions SET auto_post_run_id = $2 WHERE id = $1', [line, runId]);
    await expect(person(() => undoRun(f.c, runId, a.toUpperCase()))).rejects.toMatchObject({ code: 'ALLOCATOR_MAY_NOT_REVERSE' });
    expect(await lineStatus(pool, line)).toBe('allocated');
  });
});
