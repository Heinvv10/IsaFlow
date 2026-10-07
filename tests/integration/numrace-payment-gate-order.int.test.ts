/**
 * NUMRACE x R-035 PR5: supplier-payments-action and batch-payments-action run `process` inside
 * withJournalDateRefusal, and R-035's approval gate runs inside that call, under the row lock, before the claim
 * and the journal. So a payment (or batch) dated 2205-01-01 that its approval does not clear is refused 409
 * APPROVAL_REQUIRED, not 400 for the date; once the gate clears (enforcement off), the same date is refused 400
 * at the ledger-date window. Either way nothing is written: still approved, no journal, no bill paid.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { batchState, cleanupPr5, enforcePay, payCompany, paymentState, payRoutes, plantBatch, plantPayment } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = payRoutes(tokens);
const OUT_OF_WINDOW = '2205-01-01';

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

const company = () => payCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);

/** An APPROVED payment (approved before any enforcement), then re-dated outside the window. */
async function approvedPayment(enforceAfter: boolean) {
  const { company: c, bank } = await company();
  await plantRule(pool, c, 'owner', { documentType: 'supplier_payment', name: 'Owner pays' });
  const p = await plantPayment(pool, c, u.a, bank);
  expect((await r.payment(u.a, c, 'approve', p.id)).state.statusCode).toBe(200);
  await pool.query('UPDATE supplier_payments SET payment_date = $2::DATE WHERE id = $1', [p.id, OUT_OF_WINDOW]);
  if (enforceAfter) await enforcePay(pool, c, 'supplier_payment', u.b);
  return { c, p };
}

/** An APPROVED batch (approved before any enforcement), then re-dated outside the window. */
async function approvedBatch(enforceAfter: boolean) {
  const { company: c, bank } = await company();
  await plantRule(pool, c, 'owner', { documentType: 'payment_batch', name: 'Owner pays batches' });
  const b = await plantBatch(pool, c, u.a, bank);
  expect((await r.batch(u.a, c, 'approve', b.id)).state.statusCode).toBe(200);
  await pool.query('UPDATE supplier_payment_batches SET batch_date = $2::DATE WHERE id = $1', [b.id, OUT_OF_WINDOW]);
  if (enforceAfter) await enforcePay(pool, c, 'payment_batch', u.b);
  return { c, b };
}

describe('process: the approval gate answers before the ledger-date window', () => {
  it('payment: not cleared by its approval -> 409 APPROVAL_REQUIRED, nothing written', async () => {
    const { c, p } = await approvedPayment(true);
    const res = await r.payment(u.a, c, 'process', p.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(await paymentState(pool, p.id)).toMatchObject({ status: 'approved', journals: 0, paid: 0 });
  });

  it('payment: gate clear -> 400 at the window, nothing written', async () => {
    const { c, p } = await approvedPayment(false);
    const res = await r.payment(u.a, c, 'process', p.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(JSON.stringify(res.state.body)).toMatch(/outside 1900-01-01 to 2199-12-31/);
    expect(await paymentState(pool, p.id)).toMatchObject({ status: 'approved', journals: 0, paid: 0 });
  });

  it('batch: not cleared by its approval -> 409 APPROVAL_REQUIRED, nothing written', async () => {
    const { c, b } = await approvedBatch(true);
    const res = await r.batch(u.a, c, 'process', b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(await batchState(pool, b.id)).toMatchObject({ status: 'approved', journals: 0, paid: 0 });
  });

  it('batch: gate clear -> 400 at the window, nothing written', async () => {
    const { c, b } = await approvedBatch(false);
    const res = await r.batch(u.a, c, 'process', b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(JSON.stringify(res.state.body)).toMatch(/outside 1900-01-01 to 2199-12-31/);
    expect(await batchState(pool, b.id)).toMatchObject({ status: 'approved', journals: 0, paid: 0 });
  });
});
