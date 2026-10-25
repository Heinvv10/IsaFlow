/**
 * Global search runs every per-entity query against the real schema. Each helper catches its own SQL error and
 * returns [] (a warn in the log), so a query naming a column the table lacks — customers.account_number,
 * customer_invoices.customer_name/total, items.item_code/item_name — made that entity silently vanish from search.
 * A mocked `sql` cannot see this; this suite seeds one row of each kind and requires each to come back.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { globalSearch } from '@/modules/accounting/services/core/globalSearchService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { setup, teardown, type Ctx } from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;

describe.skipIf(!process.env.DATABASE_URL)('global search against the real schema', () => {
  beforeAll(async () => {
    assertNotProductionDb('global search columns');
    assertLocalFixtureDbUrl('DATABASE_URL', process.env.DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await setup('GSC');
    const co = c.fx.companyId;
    await sql`UPDATE customers SET email = ${`cus-${c.fx.tag}@example.test`} WHERE id = ${c.fx.customerId}::UUID`;
    await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${co}::UUID, ${c.fx.customerId}::UUID, ${c.fx.customerId}::UUID, ${`INV-${c.fx.tag}`},
        '2026-05-10', '2026-05-10', 'draft', 1000, 15, 150, 1150, 0, ${c.fx.userId}::UUID)`;
    await sql`INSERT INTO items (company_id, code, description) VALUES (${co}::UUID, ${`IT-${c.fx.tag}`}, 'Widget')`;
  }, 120000);
  afterAll(async () => {
    await sql`DELETE FROM items WHERE company_id = ${c.fx.companyId}::UUID`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${c.fx.companyId}::UUID`;
    await teardown(c);
  }, 120000);

  it('finds the customer, supplier, invoice and item by tag, with no query failing', async () => {
    const warn = vi.spyOn(log, 'warn');
    const results = await globalSearch(c.fx.companyId, c.fx.tag, 50);
    expect(warn.mock.calls.map((a) => a[0])).toEqual([]);
    warn.mockRestore();
    const byType = (t: string) => results.filter((r) => r.type === t);

    expect(byType('customer').map((r) => [r.id, r.subtitle])).toEqual([[c.fx.customerId, `cus-${c.fx.tag}@example.test`]]);
    expect(byType('supplier').map((r) => r.id)).toEqual([c.fx.supplierId]);
    const [inv] = (await sql`SELECT id FROM customer_invoices WHERE invoice_number = ${`INV-${c.fx.tag}`}`) as Row[];
    expect(byType('invoice').map((r) => [r.id, r.title, r.subtitle]))
      .toEqual([[String(inv!.id), `INV-${c.fx.tag}`, `CUS ${c.fx.tag} | R 1150.00`]]);
    expect(byType('item').map((r) => r.title)).toEqual([`IT-${c.fx.tag} — Widget`]);
  }, 60000);

  it('finds an invoice by its customer name, and a customer by email', async () => {
    const byName = await globalSearch(c.fx.companyId, `CUS ${c.fx.tag}`, 50);
    expect(byName.filter((r) => r.type === 'invoice').map((r) => r.title)).toEqual([`INV-${c.fx.tag}`]);
    const byEmail = await globalSearch(c.fx.companyId, `cus-${c.fx.tag}@`, 50);
    expect(byEmail.filter((r) => r.type === 'customer').map((r) => r.id)).toEqual([c.fx.customerId]);
  }, 60000);

  it('never returns another company\'s rows', async () => {
    const o = await setup('GSO');
    try {
      const results = await globalSearch(o.fx.companyId, c.fx.tag, 50);
      expect(results).toEqual([]);
    } finally {
      await teardown(o);
    }
  }, 120000);
});
