/**
 * K-107 round 6, census survivor MEDIUM-2 — `pages/api/accounting/stock-adjustments.ts`.
 *
 * It minted `ADJ-${COUNT(*)+1}`, the same generator fixed in five sibling
 * routes in round 5 and missed here. Count is not max: delete ONE adjustment
 * and every later create re-issues a number already in use — and
 * `stock_adjustments` had NO unique index, so the duplicate was silent, on
 * documents that move inventory value.
 *
 * The number now comes from the company's atomic `stock_adjustment` counter and
 * migration 671 adds `uq_stock_adjustments_company_number`, which is also the
 * constraint `insertWithReservedNumber` renumbers past when a legacy
 * `ADJ-nnnnn` row holds the number the sequence hands out.
 *
 * The auth/CSRF wrappers are mocked so the shipped handler runs against the
 * real fixture database.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import type { NextApiRequest, NextApiResponse } from 'next';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

const { default: adjHandler } = await import('../../pages/api/accounting/stock-adjustments');
const { ensureDocumentNumbers } = await import('../../src/modules/accounting/services/core/companySettingsService');

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), product = crypto.randomUUID();

const ctxFor = (client: PoolClient) =>
  ({ client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0]);

type Res = NextApiResponse & { statusCode: number; body?: unknown };
function makeRes(): Res {
  const res = { statusCode: 200 } as unknown as Res;
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; }) as never;
  res.json = vi.fn((b: unknown) => { res.body = b; return res; }) as never;
  res.setHeader = vi.fn(() => res) as never;
  return res;
}

/** Run the handler in its own committed transaction, exactly as withAuth does. */
async function post(body: unknown, companyId = company): Promise<Res> {
  const res = makeRes();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await als.run({ ...ctxFor(client), companyId } as never, () => adjHandler({
      method: 'POST', user: { id: user }, companyId, body, query: {},
    } as unknown as NextApiRequest, res));
    await client.query(res.statusCode >= 500 ? 'ROLLBACK' : 'COMMIT');
  } finally { client.release(); }
  return res;
}

const BODY = { productId: product, adjustmentType: 'increase', quantity: 2, unitCost: 10, reason: 'stock count' };

const numberOf = (res: Res): string =>
  String((res.body as { data?: { adjustment_number?: unknown } })?.data?.adjustment_number);

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K107 R6 stock fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO products(id,company_id,code,name,current_stock) VALUES($1,$2,$3,$4,0)',
    [product, company, `K107R6-P-${product.slice(0, 6)}`, 'K107 R6 product']);
  await ensureDocumentNumbers(company);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM stock_movements WHERE reference_type=$1 AND reference_id IN (SELECT id FROM stock_adjustments WHERE company_id=$2)', ['stock_adjustment', company]);
    await pool.query('DELETE FROM stock_adjustments WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM products WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('does not re-issue a number that is still in use after an adjustment is deleted', async () => {
  const first = await post(BODY);
  expect.soft(first.statusCode).toBe(201);
  const second = await post(BODY);
  expect.soft(numberOf(second)).not.toBe(numberOf(first));

  // Delete the FIRST, keeping the second: the count goes back by one while the
  // number the count now points at is still held. That is what made the COUNT
  // generator re-issue a live number — silently before migration 671, and as a
  // permanent 23505 after it.
  const firstId = String((first.body as { data: { id: string } }).data.id);
  await pool.query('DELETE FROM stock_movements WHERE reference_id=$1', [firstId]);
  await pool.query('DELETE FROM stock_adjustments WHERE id=$1', [firstId]);

  const third = await post(BODY);
  expect.soft(third.statusCode).toBe(201);
  expect.soft(numberOf(third)).not.toBe(numberOf(second));
  expect(numberOf(third)).not.toBe(numberOf(first));
});

it('renumbers past a legacy ADJ- row that already holds the sequence number', async () => {
  // Take the number the sequence is about to hand out and give it to a legacy
  // row first. Without the savepointed retry this 23505s the whole request.
  const peek = await pool.query(
    "SELECT prefix, next_number, padding FROM company_document_numbers WHERE company_id=$1 AND document_type='stock_adjustment'",
    [company]);
  const taken = `${peek.rows[0].prefix}${String(peek.rows[0].next_number).padStart(Number(peek.rows[0].padding), '0')}`;
  await pool.query(
    `INSERT INTO stock_adjustments(company_id,adjustment_number,product_id,adjustment_type,quantity,reason)
     VALUES($1,$2,$3,'increase',1,'legacy')`, [company, taken, product]);

  const res = await post(BODY);
  expect.soft(res.statusCode).toBe(201);
  expect(numberOf(res)).not.toBe(taken);
});

it('gives two companies their own sequences, and refuses another tenant\'s product', async () => {
  const otherCompany = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [otherCompany, 'K107 R6 stock other']);
  await ensureDocumentNumbers(otherCompany);
  const otherProduct = crypto.randomUUID();
  await pool.query('INSERT INTO products(id,company_id,code,name,current_stock) VALUES($1,$2,$3,$4,0)',
    [otherProduct, otherCompany, `K107R6-OP-${otherProduct.slice(0, 6)}`, 'other product']);

  // Their first adjustment starts at their own 1, not ours.
  const theirs = await post({ ...BODY, productId: otherProduct }, otherCompany);
  expect.soft(theirs.statusCode).toBe(201);
  expect.soft(numberOf(theirs)).toBe('ADJ0000001');

  // Our company may not adjust their product — and refuses BEFORE writing, so
  // no adjustment row and no burnt movement are left behind by the 404.
  const before = await pool.query('SELECT count(*)::int AS n FROM stock_adjustments WHERE company_id=$1', [company]);
  const cross = await post({ ...BODY, productId: otherProduct });
  expect.soft(cross.statusCode).toBe(404);
  const after = await pool.query('SELECT count(*)::int AS n FROM stock_adjustments WHERE company_id=$1', [company]);
  expect(after.rows[0].n).toBe(before.rows[0].n);

  await pool.query('DELETE FROM stock_movements WHERE reference_type=$1 AND reference_id IN (SELECT id FROM stock_adjustments WHERE company_id=$2)', ['stock_adjustment', otherCompany]);
  await pool.query('DELETE FROM stock_adjustments WHERE company_id=$1', [otherCompany]);
  await pool.query('DELETE FROM products WHERE company_id=$1', [otherCompany]);
  await pool.query('DELETE FROM company_document_numbers WHERE company_id=$1', [otherCompany]);
  await pool.query('DELETE FROM companies WHERE id=$1', [otherCompany]);
});

it('refuses a second adjustment under a number already used, rather than duplicating it', async () => {
  const res = await post(BODY);
  const mine = numberOf(res);
  const dup = await pool.query(
    `INSERT INTO stock_adjustments(company_id,adjustment_number,product_id,adjustment_type,quantity,reason)
     VALUES($1,$2,$3,'increase',1,'dup') RETURNING id`, [company, mine, product])
    .then(() => null, (err: unknown) => err);
  expect((dup as { code?: string }).code).toBe('23505');
});
