/**
 * R-035 PR5: a batch EFT is ONE approvable document (`payment_batch`), gated
 * through the real route (batch-payments-action). Approve (draft -> approved,
 * now locked, draft-only and row-count-checked) and process (one journal for
 * the batch total, every member's bills paid) each refuse 409 before any
 * write until the batch's CURRENT content — every line's payee, payee bank
 * details and amount — is approved. A member is approved only through its
 * batch: the single-payment approve on a member is judged by the batch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import { batchState, cleanupPr5, enforcePay, payCompany, payRoutes, plantBatch, plantPayment } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', m: '' };
const r = payRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

const company = () => payCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.m, 'manager']], companies);

async function gated(opts: { enforced?: boolean; rule?: { operator: string; value: number } } = {}) {
  const { company: c, bank } = await company();
  await plantRule(pool, c, 'owner', { documentType: 'payment_batch', name: 'Owner pays batches', ...opts.rule });
  if (opts.enforced !== false) await enforcePay(pool, c, 'payment_batch', u.b);
  return { c, bank, b: await plantBatch(pool, c, u.a, bank) };
}

async function footprint(id: string) {
  const { rows: [row] } = await pool.query(
    'SELECT status, processed_by, processed_at, updated_at FROM supplier_payment_batches WHERE id = $1', [id]);
  return { ...row, ...(await batchState(pool, id)) };
}

describe('approve', () => {
  it('refuses 409 APPROVAL_REQUIRED before any write, naming the batch', async () => {
    const { c, b } = await gated();
    const before = await footprint(b.id);
    const res = await r.batch(u.a, c, 'approve', b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(messageOf(res)).toBe(`Payment batch ${b.number} needs owner approval before it can be paid (rule: Owner pays batches).`);
    expect(await footprint(b.id)).toEqual(before);
    expect(before).toMatchObject({ status: 'draft', members: ['draft', 'draft'], journals: 0, paid: 0 });
  });

  it('one request covers the batch: A raises, B approves, A approves and processes — every line paid', async () => {
    const { c, b } = await gated();
    await r.approvedBy(pool, u.a, u.b, c, 'payment_batch', b.id);
    expect((await r.batch(u.a, c, 'approve', b.id)).state.statusCode).toBe(200);
    const approvedBy = (await pool.query('SELECT DISTINCT approved_by FROM supplier_payments WHERE batch_id = $1', [b.id])).rows;
    expect(approvedBy).toEqual([{ approved_by: u.a }]);
    const res = await r.batch(u.a, c, 'process', b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await batchState(pool, b.id)).toMatchObject({ status: 'processed', members: ['processed', 'processed'], journals: 1, paid: 3450 });
  });

  it('changing one line after approval makes it STALE; reverting the line clears it (Q9)', async () => {
    const { c, b } = await gated();
    await r.approvedBy(pool, u.a, u.b, c, 'payment_batch', b.id);
    await pool.query("UPDATE supplier_payments SET reference = 'moved' WHERE id = $1", [b.members[1]!.id]);
    const stale = await r.batch(u.a, c, 'approve', b.id);
    expect(reasonOf(stale)).toBe('APPROVAL_STALE');
    await pool.query("UPDATE supplier_payments SET reference = 'R035 ref' WHERE id = $1", [b.members[1]!.id]);
    expect((await r.batch(u.a, c, 'approve', b.id)).state.statusCode).toBe(200);
  });

  it('approving a batch that is no longer a draft is refused 409, not a silent 200', async () => {
    const { c, b } = await gated({ enforced: false });
    expect((await r.batch(u.a, c, 'approve', b.id)).state.statusCode).toBe(200);
    const again = await r.batch(u.a, c, 'approve', b.id);
    expect(again.state.statusCode).toBe(409);
    expect(messageOf(again)).toBe('Batch is approved, not draft — it cannot be approved.');
  });

  it("a member's single-payment approve is judged by its BATCH's approval", async () => {
    const { c, b } = await gated();
    const res = await r.payment(u.a, c, 'approve', b.members[0]!.id);
    expect(res.state.statusCode).toBe(409);
    expect(messageOf(res)).toMatch(/^Payment batch /);
    await r.approvedBy(pool, u.a, u.b, c, 'payment_batch', b.id);
    expect((await r.payment(u.a, c, 'approve', b.members[0]!.id)).state.statusCode).toBe(200);
  });

  it('a member cannot be raised for as a supplier_payment (it has no approval of its own)', async () => {
    const { c, b } = await gated();
    const res = await r.raise(u.a, c, 'supplier_payment', b.members[0]!.id);
    expect(res.state.statusCode).toBe(400);
    expect(messageOf(res)).toBe(`No supplier_payment ${b.members[0]!.id} exists for this company`);
  });
});

describe('process', () => {
  it('a batch approved before enforcement is refused 409 at process: no journal, no bill paid', async () => {
    const { c, b } = await gated({ enforced: false });
    expect((await r.batch(u.a, c, 'approve', b.id)).state.statusCode).toBe(200);
    await enforcePay(pool, c, 'payment_batch', u.b);
    const before = await footprint(b.id);
    const res = await r.batch(u.a, c, 'process', b.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(await footprint(b.id)).toEqual(before);
    expect(before).toMatchObject({ status: 'approved', processed_by: null, journals: 0, paid: 0 });
  });

  it("a payee's bank details changed between approve and process: STALE at process", async () => {
    const { c, b } = await gated();
    await r.approvedBy(pool, u.a, u.b, c, 'payment_batch', b.id);
    expect((await r.batch(u.a, c, 'approve', b.id)).state.statusCode).toBe(200);
    await pool.query("UPDATE suppliers SET bank_account_number = '999' WHERE id = $1", [b.members[0]!.supplierId]);
    const res = await r.batch(u.a, c, 'process', b.id);
    expect(reasonOf(res)).toBe('APPROVAL_STALE');
    expect((await batchState(pool, b.id)).journals).toBe(0);
  });

  it('the gate amount is the larger of the stored total and the members: a R10 stored total still meets a R1 000 rule', async () => {
    const { c, b } = await gated({ rule: { operator: 'greater_than', value: 1000 } });
    await pool.query('UPDATE supplier_payment_batches SET total_amount = 10 WHERE id = $1', [b.id]);
    expect((await r.batch(u.a, c, 'approve', b.id)).state.statusCode).toBe(409);
  });
});

describe('scope', () => {
  it('enforcement off: approve and process run as before', async () => {
    const { c, b } = await gated({ enforced: false });
    expect((await r.batch(u.a, c, 'approve', b.id)).state.statusCode).toBe(200);
    expect((await r.batch(u.a, c, 'process', b.id)).state.statusCode).toBe(200);
  });

  it('the types are coupled (D1): a supplier_payment rule gates a batch paying that much; a batch rule never gates a single payment', async () => {
    const { company: c, bank } = await company();
    await plantRule(pool, c, 'owner', { documentType: 'supplier_payment' });
    await enforcePay(pool, c, 'supplier_payment', u.b);
    const b = await plantBatch(pool, c, u.a, bank);
    expect((await r.batch(u.a, c, 'approve', b.id)).state.statusCode).toBe(409);
    const { company: c2, bank: bank2 } = await company();
    await plantRule(pool, c2, 'owner', { documentType: 'payment_batch' });
    await enforcePay(pool, c2, 'payment_batch', u.b);
    const p = await plantPayment(pool, c2, u.a, bank2);
    expect((await r.payment(u.a, c2, 'approve', p.id)).state.statusCode).toBe(200);
  });

  it('the batch detail GET shows the derived state', async () => {
    const { c, b } = await gated();
    const res = await r.getBatch(u.a, c, b.id);
    expect(dataOf<{ approval: { state: string } }>(res).approval.state).toBe('required');
  });
});
