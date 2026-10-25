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
    if (!c) return; // setup failed: its own error is the one to read
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

  it('skips soft-deleted customers, suppliers, invoices and items; an invoice keeps a deleted customer\'s name', async () => {
    const co = c.fx.companyId;
    const gone = `GONE-${c.fx.tag}`;
    const [cus] = (await sql`
      INSERT INTO customers (company_id, name, deleted_at) VALUES (${co}::UUID, ${`${gone} cus`}, NOW()) RETURNING id`) as Row[];
    await sql`INSERT INTO suppliers (company_id, name, deleted_at) VALUES (${co}::UUID, ${`${gone} sup`}, NOW())`;
    await sql`INSERT INTO items (company_id, code, description, deleted_at) VALUES (${co}::UUID, ${`${gone}-IT`}, 'Gone', NOW())`;
    await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by, deleted_at)
      VALUES (${co}::UUID, ${c.fx.customerId}::UUID, ${c.fx.customerId}::UUID, ${`${gone}-INV`},
        '2026-05-10', '2026-05-10', 'draft', 1, 15, 0, 1, 0, ${c.fx.userId}::UUID, NOW()),
             (${co}::UUID, ${cus!.id}::UUID, ${cus!.id}::UUID, ${`LIVE-${c.fx.tag}`},
        '2026-05-10', '2026-05-10', 'draft', 1, 15, 0, 1, 0, ${c.fx.userId}::UUID, NULL)`;
    const types = (await globalSearch(co, gone, 50)).map((r) => [r.type, r.title]);
    expect(types).toEqual([['invoice', `LIVE-${c.fx.tag}`]]);
  }, 60000);

  it('the user\'s % and _ match literally, not as wildcards', async () => {
    expect(await globalSearch(c.fx.companyId, '%', 50)).toEqual([]);
    expect(await globalSearch(c.fx.companyId, '_', 50)).toEqual([]);
    expect((await globalSearch(c.fx.companyId, `INV_${c.fx.tag.slice(1)}`, 50)).filter((r) => r.type === 'invoice')).toEqual([]);
  }, 60000);

  it('an invoice whose customer row is another company\'s shows no name, just its total', async () => {
    const o = await setup('GSX');
    try {
      const [inv] = (await sql`
        INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
          status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
        VALUES (${c.fx.companyId}::UUID, ${o.fx.customerId}::UUID, ${o.fx.customerId}::UUID, ${`ORPHAN-${c.fx.tag}`},
          '2026-05-10', '2026-05-10', 'draft', 10, 15, 1.5, 11.5, 0, ${c.fx.userId}::UUID)
        RETURNING id`) as Row[];
      const hit = (await globalSearch(c.fx.companyId, `ORPHAN-${c.fx.tag}`, 50)).filter((r) => r.type === 'invoice');
      expect(hit.map((r) => [r.id, r.subtitle])).toEqual([[String(inv!.id), 'R 11.50']]);
      // ...and the other company's customer name finds nothing here.
      expect((await globalSearch(c.fx.companyId, `CUS ${o.fx.tag}`, 50)).filter((r) => r.type === 'invoice')).toEqual([]);
    } finally {
      await sql`DELETE FROM customer_invoices WHERE invoice_number = ${`ORPHAN-${c.fx.tag}`}`;
      await teardown(o);
    }
  }, 120000);

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
