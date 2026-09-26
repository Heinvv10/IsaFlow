/**
 * K-061 refusals. withAuth COMMITs on a 4xx, so every refusal must leave
 * every census table exactly as it was — asserted by digest over both
 * companies, not by the status code alone. Also: two merges racing in
 * opposite directions must not both succeed.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { k061 } from './k061-customer-merge.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const h = k061(pool);
let source = '';
let target = '';
let foreign = '';

beforeAll(h.setUp);
afterAll(h.tearDown);
beforeEach(async () => {
  await h.wipe();
  source = await h.customer(h.companyA, 'K061 Refuse Source');
  target = await h.customer(h.companyA, 'K061 Refuse Target');
  foreign = await h.customer(h.companyB, 'K061 Other Tenant');
  await h.footprint(h.companyA, source, 's');
  await h.footprint(h.companyA, target, 't');
  await h.footprint(h.companyB, foreign, 'f');
  await pool.query('DELETE FROM customer_dunning_overrides WHERE customer_id=$1', [target]);
});

async function refusedUntouched(body: Record<string, unknown>, expected = 400) {
  const before = await h.snapshot();
  const result = await h.merge(body);
  expect(result.state.statusCode).toBe(expected);
  expect(await h.snapshot()).toBe(before);
  return result;
}

it('refuses another tenant\'s customer as the source, changing nothing in either tenant', async () => {
  await refusedUntouched({ source_id: foreign, target_id: target });
});

it('refuses another tenant\'s customer as the target, changing nothing in either tenant', async () => {
  await refusedUntouched({ source_id: source, target_id: foreign });
});

it('refuses a merge into itself, saying why', async () => {
  const result = await refusedUntouched({ source_id: source, target_id: source });
  expect(JSON.stringify(result.state.body)).toMatch(/different customers/);
});

it('refuses a soft-deleted target', async () => {
  await pool.query('UPDATE customers SET deleted_at = NOW() WHERE id=$1', [target]);
  await refusedUntouched({ source_id: source, target_id: target });
});

it('refuses ids that are not UUIDs with a 400, not a 500', async () => {
  await refusedUntouched({ source_id: 'not-a-uuid', target_id: target });
  await refusedUntouched({ source_id: source, target_id: 42 });
  await refusedUntouched({ source_id: source });
});

it('refuses when both customers have a dunning override, naming the conflict', async () => {
  await pool.query('INSERT INTO customer_dunning_overrides(company_id,customer_id,suppress_dunning) VALUES($1,$2,true)', [h.companyA, target]);
  const result = await refusedUntouched({ source_id: source, target_id: target });
  expect(JSON.stringify(result.state.body)).toMatch(/dunning/i);
});

it('two merges racing in opposite directions: exactly one succeeds and nothing is split', async () => {
  const [ab, ba] = await Promise.all([
    h.merge({ source_id: source, target_id: target }),
    h.merge({ source_id: target, target_id: source }),
  ]);
  const codes = [ab.state.statusCode, ba.state.statusCode].sort();
  expect(codes).toEqual([200, 400]);
  const { rows } = await pool.query(
    'SELECT count(*)::int AS live FROM customers WHERE id = ANY($1) AND deleted_at IS NULL', [[source, target]]);
  expect(rows[0].live).toBe(1);
  const owners = await pool.query(
    'SELECT DISTINCT COALESCE(client_id, customer_id) AS who FROM customer_invoices WHERE company_id=$1', [h.companyA]);
  expect(owners.rows).toHaveLength(1);
});
