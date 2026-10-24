/**
 * K-061: the /accounting/duplicates page merges customers through a second
 * route, POST /api/accounting/duplicates-merge. It used to run its own merge,
 * which moved five tables and left the duplicate's contacts, portal logins
 * and active recurring invoices on a deleted customer. It now runs the same
 * customerMergeService, so it moves the whole census and obeys the same
 * refusals — pinned here through the real route.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { k061, MOVED } from './k061-customer-merge.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const h = k061(pool);
let primary = '';
let duplicate = '';

beforeAll(h.setUp);
afterAll(h.tearDown);
beforeEach(async () => {
  await h.wipe();
  duplicate = await h.customer(h.companyA, 'K061 Dup Page Duplicate');
  primary = await h.customer(h.companyA, 'K061 Dup Page Primary');
  await h.footprint(h.companyA, duplicate, 'd');
  await h.footprint(h.companyA, primary, 'p');
  await pool.query('DELETE FROM customer_dunning_overrides WHERE customer_id=$1', [primary]);
});

it('moves every census reference off the duplicate and counts the documents it re-parented', async () => {
  const result = await h.mergeDuplicate({ entityType: 'customer', primaryId: primary, duplicateId: duplicate });
  expect(result.state.statusCode).toBe(200);
  // 2 invoices, 1 receipt, 1 credit note, 1 quote, 1 sales order.
  const data = (result.state.body as { data: { reassignedTransactions: number; pausedRecurring: number } }).data;
  expect(data.reassignedTransactions).toBe(6);
  // The page shows this count: one recurring invoice + one recurring template.
  expect(data.pausedRecurring).toBe(2);
  expect(await h.references(duplicate)).toEqual(Object.fromEntries(MOVED.map(([t, c]) => [`${t}.${c}`, 0])));
  const { rows } = await pool.query(
    `SELECT (SELECT status FROM recurring_invoices WHERE template_name='R-d' AND company_id=$1) AS recurring,
            (SELECT count(*)::int FROM portal_access WHERE client_id=$2) AS portal,
            (SELECT deleted_at IS NOT NULL FROM customers WHERE id=$2) AS gone`, [h.companyA, duplicate]);
  // The duplicate's portal login is removed (S-07d, 935: no app role may UPDATE portal_access).
  expect(rows[0]).toEqual({ recurring: 'paused', portal: 0, gone: true });
});

it('refuses with 400 and changes nothing when both customers have a dunning override', async () => {
  await pool.query('INSERT INTO customer_dunning_overrides(company_id,customer_id) VALUES($1,$2)', [h.companyA, primary]);
  const before = await h.snapshot();
  const result = await h.mergeDuplicate({ entityType: 'customer', primaryId: primary, duplicateId: duplicate });
  expect(result.state.statusCode).toBe(400);
  expect(JSON.stringify(result.state.body)).toMatch(/dunning/i);
  expect(await h.snapshot()).toBe(before);
});

it('refuses another tenant\'s customer and a non-UUID id with 400, changing nothing', async () => {
  const foreign = await h.customer(h.companyB, 'K061 Dup Page Foreign');
  for (const body of [
    { entityType: 'customer', primaryId: primary, duplicateId: foreign },
    { entityType: 'customer', primaryId: 'nope', duplicateId: duplicate },
  ]) {
    const before = await h.snapshot();
    const result = await h.mergeDuplicate(body);
    expect(result.state.statusCode).toBe(400);
    expect(await h.snapshot()).toBe(before);
  }
});
