/**
 * Stock-item batch writes (2026-11-07, found seeding the Demo company).
 *
 *  - POST /api/accounting/item-opening-balances answered 200 `{ updated: n }` for ids that matched no stock item
 *    of this company: the UPDATEs touched nothing and the count was the request's length.
 *  - PUT /api/accounting/item-pricing updated entries one at a time and 404'd on the first unknown id, after the
 *    earlier entries were written. withAuth commits a 4xx, so the batch was half applied.
 * Both now check every id against this company's stock items before writing anything, and refuse with a 404 that
 * names the missing ids.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import openingBalances from '../../pages/api/accounting/item-opening-balances';
import pricing from '../../pages/api/accounting/item-pricing';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';
import type { Route } from './d12-helpers';
import { callAs } from './fleet-helpers';

let c: Ctx;
let token = '';
let other = '';
type Row = Record<string, unknown>;

async function stockItem(company: string, code: string): Promise<string> {
  return String(((await sql`
    INSERT INTO stock_items (company_id, item_code, name, standard_cost, list_price, qty_available)
    VALUES (${company}::UUID, ${code}, ${`Item ${code}`}, 10, 20, 1)
    RETURNING id`) as Row[])[0]!.id);
}

const item = async (id: string) => ((await sql`
  SELECT qty_available::FLOAT AS qty, standard_cost::FLOAT AS cost, list_price::FLOAT AS price
  FROM stock_items WHERE id = ${id}::UUID`) as Row[])[0]!;

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('stock-item batch writes refuse unknown ids', () => {
  beforeAll(async () => {
    assertNotProductionDb('stock item writes');
    assertLocalFixtureDbUrl('DATABASE_URL', process.env.DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    ({ c, token } = await setupWithUser('SIW'));
    other = crypto.randomUUID();
    await sql`INSERT INTO companies (id, name, registration_number)
      VALUES (${other}::UUID, ${`SIW other ${c.fx.tag}`}, ${`SIW-${other.slice(0, 8)}`})`;
  }, 120000);
  afterAll(async () => {
    await sql`DELETE FROM stock_items WHERE company_id IN (${c.fx.companyId}::UUID, ${other}::UUID)`;
    await sql`DELETE FROM companies WHERE id = ${other}::UUID`;
    await clearExtras(c); await teardown(c);
  }, 120000);

  it('opening balances: sets every known item and reports how many', async () => {
    const a = await stockItem(c.fx.companyId, 'OB-A');
    const b = await stockItem(c.fx.companyId, 'OB-B');
    const out = await callAs(c, token, openingBalances as Route, 'POST',
      { items: [{ itemId: a, quantity: 20, unitCost: 55 }, { itemId: b, quantity: 3, unitCost: 7.5 }] });
    expect(out.status, out.body).toBe(200);
    expect(out.data).toEqual({ updated: 2 });
    expect(await item(a)).toMatchObject({ qty: 20, cost: 55 });
    expect(await item(b)).toMatchObject({ qty: 3, cost: 7.5 });
  });

  it.each([
    ['an id that is no stock item', () => crypto.randomUUID()],
    ["another company's stock item", () => stockItem(other, 'OB-FOREIGN')],
  ])('opening balances: %s is a 404 and nothing in the batch is written', async (_label, make) => {
    const known = await stockItem(c.fx.companyId, `OB-K-${Date.now()}`);
    const missing = await make();
    const out = await callAs(c, token, openingBalances as Route, 'POST',
      { items: [{ itemId: known, quantity: 99, unitCost: 99 }, { itemId: missing, quantity: 5, unitCost: 5 }] });
    expect(out.status, out.body).toBe(404);
    expect(out.body).toContain(missing);
    expect(await item(known)).toMatchObject({ qty: 1, cost: 10 });
    const touched = (await sql`SELECT COUNT(*)::INT AS n FROM stock_items
      WHERE id = ${missing}::UUID AND (qty_available <> 1 OR standard_cost <> 10)`) as Row[];
    expect(touched).toEqual([{ n: 0 }]);
  });

  it('pricing: an unknown id later in the batch is a 404 and the earlier entries are not written', async () => {
    const known = await stockItem(c.fx.companyId, 'PR-K');
    const missing = crypto.randomUUID();
    const out = await callAs(c, token, pricing as Route, 'PUT',
      { updates: [{ itemId: known, sellingPrice: 499 }, { itemId: missing, sellingPrice: 1 }] });
    expect(out.status, out.body).toBe(404);
    expect(out.body).toContain(missing);
    expect(await item(known)).toMatchObject({ price: 20 });
  });

  it('pricing: a batch of known items is applied', async () => {
    const a = await stockItem(c.fx.companyId, 'PR-A');
    const out = await callAs(c, token, pricing as Route, 'PUT', { updates: [{ itemId: a, sellingPrice: 129.5 }] });
    expect(out.status, out.body).toBe(200);
    expect(out.data).toEqual({ updated: 1 });
    expect(await item(a)).toMatchObject({ price: 129.5 });
  });
});
