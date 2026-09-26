/**
 * K-061: POST /api/accounting/customer-merge moves every reference the
 * census names from the source customer to the target, in one transaction,
 * through the real route (withAuth → app_user, RLS). Before the fix every
 * merge died on `customer_payments.customer_id` (42703) and rolled back.
 *
 * Hein's decisions (2026-09-26) are pinned here too: the source's portal
 * logins are revoked, its recurring templates move but are paused, and a
 * dunning override moves when only the source has one.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { k061, MOVED } from './k061-customer-merge.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const h = k061(pool);
let source = '';
let target = '';

beforeAll(h.setUp);
afterAll(h.tearDown);
beforeEach(async () => {
  await h.wipe();
  source = await h.customer(h.companyA, 'K061 Duplicate Ltd');
  target = await h.customer(h.companyA, 'K061 Survivor Ltd');
  await h.footprint(h.companyA, source, 's');
  await h.footprint(h.companyA, target, 't');
  // The target keeps its own dunning override; only the source's is moved in
  // the one test that needs it, so the default case has no conflict.
  await pool.query('DELETE FROM customer_dunning_overrides WHERE customer_id=$1', [target]);
});

it('moves every census reference to the target and leaves the source with none', async () => {
  const before = await h.references(target);
  const result = await h.merge({ source_id: source, target_id: target });
  expect(result.state.statusCode).toBe(200);

  const left = await h.references(source);
  expect(left).toEqual(Object.fromEntries(MOVED.map(([t, c]) => [`${t}.${c}`, 0])));
  const after = await h.references(target);
  for (const [t, c] of MOVED) {
    const key = `${t}.${c}`;
    // customer_invoices.client_id: the source's NULL-client_id invoice stays NULL.
    // entity_udf_values: both set field 1, so the target's value stands and none moves.
    const moved = key === 'customer_invoices.customer_id' ? 2 : key === 'entity_udf_values.entity_id' ? 0 : 1;
    expect(after[key], key).toBe(before[key]! + moved);
  }
});

it('moves invoices on both columns, keeping a NULL client_id NULL, so COALESCE names the target', async () => {
  await h.merge({ source_id: source, target_id: target });
  const { rows } = await pool.query(
    `SELECT invoice_number, customer_id, client_id FROM customer_invoices
     WHERE company_id=$1 AND invoice_number LIKE 'K061-s-%' ORDER BY invoice_number`, [h.companyA]);
  expect(rows).toEqual([
    { invoice_number: 'K061-s-1', customer_id: target, client_id: null },
    { invoice_number: 'K061-s-2', customer_id: target, client_id: target },
  ]);
});

it('the target owes both customers\' debt and the source owes nothing', async () => {
  await h.merge({ source_id: source, target_id: target });
  const { rows } = await pool.query(
    `SELECT COALESCE(ci.client_id, ci.customer_id) AS who, sum(total_amount)::float8 AS owed
     FROM customer_invoices ci WHERE company_id=$1 GROUP BY 1`, [h.companyA]);
  expect(rows).toEqual([{ who: target, owed: 600 }]);
  const paid = await pool.query(
    'SELECT client_id, sum(total_amount)::float8 AS paid FROM customer_payments WHERE company_id=$1 GROUP BY 1', [h.companyA]);
  expect(paid.rows).toEqual([{ client_id: target, paid: 80 }]);
});

it('soft-deletes the source, and a second merge of it is refused', async () => {
  await h.merge({ source_id: source, target_id: target });
  const { rows } = await pool.query('SELECT deleted_at IS NOT NULL AS gone, is_active FROM customers WHERE id=$1', [source]);
  expect(rows[0]).toEqual({ gone: true, is_active: false });
  const again = await h.merge({ source_id: source, target_id: target });
  expect(again.state.statusCode).toBe(400);
});

it('revokes the source\'s portal logins and leaves the target\'s alone', async () => {
  await h.merge({ source_id: source, target_id: target });
  const { rows } = await pool.query(
    'SELECT client_id, is_active FROM portal_access WHERE client_id = ANY($1) ORDER BY is_active', [[source, target]]);
  expect(rows).toEqual([{ client_id: source, is_active: false }, { client_id: target, is_active: true }]);
});

it('moves the source\'s recurring invoices AND recurring transaction templates paused, counts both, leaves the target\'s running', async () => {
  const result = await h.merge({ source_id: source, target_id: target });
  expect((result.state.body as { data: { pausedRecurring: number } }).data.pausedRecurring).toBe(2);
  const { rows } = await pool.query(
    'SELECT template_name, status FROM recurring_invoices WHERE client_id=$1 ORDER BY template_name', [target]);
  expect(rows).toEqual([{ template_name: 'R-s', status: 'paused' }, { template_name: 'R-t', status: 'active' }]);
  const t = await pool.query(
    `SELECT name, is_active FROM recurring_transaction_templates
     WHERE company_id=$1 AND template_data->>'clientId' = $2::text ORDER BY name`, [h.companyA, target]);
  expect(t.rows).toEqual([{ name: 'T-s', is_active: false }, { name: 'T-t', is_active: true }]);
});

it('keeps the target\'s primary contact and default address; the moved ones are not primary or default', async () => {
  await h.merge({ source_id: source, target_id: target });
  const c = await pool.query('SELECT full_name, is_primary FROM customer_contacts WHERE customer_id=$1 ORDER BY full_name', [target]);
  expect(c.rows).toEqual([{ full_name: 'Contact s', is_primary: false }, { full_name: 'Contact t', is_primary: true }]);
  const a = await pool.query('SELECT label, is_default FROM customer_delivery_addresses WHERE customer_id=$1 ORDER BY label', [target]);
  expect(a.rows).toEqual([{ label: 'Addr s', is_default: false }, { label: 'Addr t', is_default: true }]);
});

it('a custom field both customers set keeps the target\'s value; one only the source set moves', async () => {
  await pool.query("INSERT INTO entity_udf_values(company_id,entity_type,entity_id,field_number,value) VALUES($1,'customer',$2,2,'only source')", [h.companyA, source]);
  const result = await h.merge({ source_id: source, target_id: target });
  expect(result.state.statusCode).toBe(200);
  const { rows } = await pool.query(
    "SELECT entity_id, field_number, value FROM entity_udf_values WHERE entity_type='customer' AND entity_id = ANY($1) ORDER BY entity_id=$2, field_number",
    [[source, target], target]);
  // Field 1 conflicts: the target's value stands, the source's is discarded with the source.
  expect(rows).toEqual([
    { entity_id: target, field_number: 1, value: 'udf t' },
    { entity_id: target, field_number: 2, value: 'only source' },
  ]);
});

it('moves a dunning override that only the source has', async () => {
  const result = await h.merge({ source_id: source, target_id: target });
  expect(result.state.statusCode).toBe(200);
  const { rows } = await pool.query('SELECT customer_id FROM customer_dunning_overrides WHERE company_id=$1', [h.companyA]);
  expect(rows).toEqual([{ customer_id: target }]);
});

it('an invoice whose columns name different customers moves only the column naming the source', async () => {
  const third = await h.customer(h.companyA, 'K061 Third Party');
  const ins = `INSERT INTO customer_invoices(company_id,invoice_number,customer_id,client_id,invoice_date,subtotal,total_amount,status,created_by)
               VALUES($1,$2,$3,$4,'2026-06-09',70,70,'approved',$5)`;
  await pool.query(ins, [h.companyA, 'K061-X-1', source, third, h.admin]); // belongs to third (COALESCE)
  await pool.query(ins, [h.companyA, 'K061-X-2', third, source, h.admin]); // belongs to source
  const result = await h.merge({ source_id: source, target_id: target });
  expect(result.state.statusCode).toBe(200);
  const { rows } = await pool.query(
    `SELECT invoice_number, customer_id, client_id, COALESCE(client_id, customer_id) AS owner
     FROM customer_invoices WHERE company_id=$1 AND invoice_number LIKE 'K061-X-%' ORDER BY invoice_number`, [h.companyA]);
  expect(rows).toEqual([
    { invoice_number: 'K061-X-1', customer_id: target, client_id: third, owner: third },
    { invoice_number: 'K061-X-2', customer_id: third, client_id: target, owner: target },
  ]);
});
