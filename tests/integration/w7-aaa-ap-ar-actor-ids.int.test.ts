/**
 * Wave 7 AAa (W20 part 1, no migration): the ten AP/AR tables' actor columns (created_by, approved_by, cancelled_by,
 * processed_by, confirmed_by) are compared as text and written with an untyped bind, so AAb can turn them to TEXT with no
 * code change. The columns are still uuid here, so a non-UUID WRITE still fails 22P02 on the column: that test is AAb's.
 *
 *  1. Every one of the ten tables has at least one actor column, and `col::text = <non-UUID id>` on each returns no rows
 *     (the compare form the code uses), where the old `col = <id>::uuid` form raised 22P02 on a uuid column.
 *  2. An upper-case UUID actor writes through the real services (create recurring journal, create and cancel an
 *     accounting adjustment) and compares equal, as text, to its lower-case form.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { createRecurringJournal } from '@/modules/accounting/services/gl/recurringJournalService';
import { cancelAdjustment, createAdjustment } from '@/modules/accounting/services/items/adjustmentService';
import { createRecurringInvoice } from '@/modules/accounting/services/ar/recurringInvoiceService';
import { runRecurringInvoice } from '@/modules/accounting/services/ar/recurringInvoiceRun';
import { rig } from './brkr.helpers';

const TABLES = ['supplier_invoices', 'supplier_payments', 'customer_payments', 'credit_notes', 'recurring_invoices',
  'customer_write_offs', 'accounting_adjustments', 'supplier_payment_batches', 'recurring_journals', 'vat_adjustments'];
const ACTOR = ['created_by', 'approved_by', 'cancelled_by', 'processed_by', 'confirmed_by'];
const NON_UUID = `sage-import-bot-w7aaa-${Date.now()}`;

let r: Awaited<ReturnType<typeof rig>>;
beforeAll(async () => { r = await rig('w7-aaa'); await r.setup(); }, 60000);
afterAll(async () => { await r.teardown(); }, 60000);

async function rolledBack<T>(user: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c: PoolClient = await r.pool.connect();
  await c.query('BEGIN');
  try {
    return await als.run({ client: c, userId: user, companyId: r.company, claims: { sub: user } } as never, () => fn(c));
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

describe('AP/AR actor ids are compared as text (AAa)', () => {
  it('each of the ten tables has actor columns, and a text compare with a non-UUID id returns no rows', async () => {
    const cols = (await r.pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1) AND column_name = ANY($2) AND data_type IN ('uuid', 'text')`,
      [TABLES, ACTOR])).rows as { table_name: string; column_name: string }[];
    expect([...new Set(cols.map((c) => c.table_name))].sort()).toEqual([...TABLES].sort());
    for (const { table_name, column_name } of cols) {
      const res = await r.pool.query(`SELECT count(*)::int AS n FROM ${table_name} WHERE company_id = $1 AND ${column_name}::text = $2`, [r.company, NON_UUID]);
      expect(res.rows[0].n, `${table_name}.${column_name}`).toBe(0);
    }
  });

  it('an upper-case UUID actor writes through the services and compares equal as text', async () => {
    const upper = crypto.randomUUID().toUpperCase();
    await rolledBack(upper, async (c) => {
      await c.query('INSERT INTO users(id,email,role,is_active) VALUES($1,$2,\'admin\',true)', [upper, `${upper}@example.invalid`]);
      await c.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,\'admin\')', [r.company, upper]);
      const journal = await createRecurringJournal(r.company, {
        templateName: 'AAa', frequency: 'monthly', nextRunDate: '2027-01-01',
        lines: [{ accountId: crypto.randomUUID(), debit: 10, credit: 0 }, { accountId: crypto.randomUUID(), debit: 0, credit: 10 }],
      } as never, upper);
      const [j] = (await sql`SELECT created_by::text AS by FROM recurring_journals WHERE id = ${journal.id}::uuid AND company_id = ${r.company}::uuid`) as { by: string }[];
      expect(j!.by).toBe(upper.toLowerCase());
      const same = (await sql`SELECT id FROM recurring_journals WHERE company_id = ${r.company}::uuid AND created_by::text = ${upper.toLowerCase()}`) as unknown[];
      expect(same).toHaveLength(1);
      const customer = crypto.randomUUID();
      await c.query("INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'AAa customer')", [customer, r.company]);
      const adj = await createAdjustment(r.company, {
        entityType: 'customer', entityId: customer, adjustmentType: 'debit', amount: 5, reason: 'AAa',
      } as never, upper);
      const [a] = (await sql`SELECT created_by::text AS by FROM accounting_adjustments WHERE id = ${adj.id}::uuid AND company_id = ${r.company}::uuid`) as { by: string }[];
      expect(a!.by).toBe(upper.toLowerCase());
      await cancelAdjustment(r.company, adj.id);
    });
  });

  it('a non-UUID actor is stored as given in the varchar customer_invoices.created_by (only an untyped bind allows it)', async () => {
    // customer_invoices.created_by is varchar, recurring_invoices.created_by still uuid: the template is made by a UUID user and
    // RUN by a non-UUID one. `${userId}::UUID` in recurringInvoiceRun raised 22P02 here on master.
    const creator = crypto.randomUUID();
    await rolledBack(NON_UUID, async (c) => {
      for (const id of [creator, NON_UUID]) {
        await c.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [id, `${id}@example.invalid`]);
        await c.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [r.company, id]);
      }
      for (const [code, type, normal, sub] of [['1200', 'asset', 'debit', 'receivable'], ['4000', 'revenue', 'credit', 'default_revenue'], ['2200', 'liability', 'credit', 'vat_output']]) {
        await c.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, account_subtype, is_system_account)
          VALUES ($1,$2,$3,$4,$5,1,$6,true)`, [r.company, code, `AAa ${code}`, type, normal, sub]);
      }
      const customer = crypto.randomUUID();
      await c.query("INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'AAa recurring customer')", [customer, r.company]);
      const tpl = await createRecurringInvoice(r.company, {
        templateName: 'AAa', clientId: customer, frequency: 'monthly', nextRunDate: '2026-01-01',
        lineItems: [{ description: 'Service', quantity: 1, unitPrice: 100 }],
      } as never, creator);
      const run = await runRecurringInvoice(r.company, tpl.id, NON_UUID);
      const [inv] = (await sql`SELECT created_by FROM customer_invoices WHERE id = ${run.invoiceId}::uuid AND company_id = ${r.company}::uuid`) as { created_by: string }[];
      expect(inv!.created_by).toBe(NON_UUID);
    });
  });
});
