/**
 * FX PR0, the database half, review round 1 (migration 871):
 *
 * - A foreign document written while the switch was on cannot be POSTED once
 *   it is off: entering the posted population, or taking a journal link, is
 *   refused; cancelling it, or an edit that touches none of the gate's
 *   columns, is not.
 * - Only a role that bypasses RLS may move fx_documents_enabled; app_user,
 *   whose admin policy reaches its own company row, may not.
 * - Blank is the functional currency, as the services read it.
 * - The supplier settlement arms: an importer's non-zero amount_paid on a
 *   foreign bill, and a no-op amount_paid UPDATE.
 * - The migration names a row its CHECKs would reject, and bounds its locks.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanup, createUser, enableFxDocuments, newCompany, plantBill } from './r035-approval.helpers';
import { asAppUser, plantInvoice } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';
const MIGRATION = readFileSync(resolve(__dirname, '../../scripts/migrations/sql/871_fx_pr0_refuse_foreign_currency.sql'), 'utf8');

beforeAll(async () => { user = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('UPDATE customer_invoices SET gl_journal_entry_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM credit_notes WHERE company_id = ANY($1)', [companies]);
  await cleanup(pool, companies, [user]);
});

/** A company holding one legacy foreign document of each kind, its switch then turned off. */
async function legacy() {
  const c = await newCompany(pool, [[user, 'owner']], companies);
  await enableFxDocuments(pool, c);
  const inv = await plantInvoice(pool, c, user, { currencyCode: 'USD', exchangeRate: 18.5 });
  const bill = await plantBill(pool, c, user, { currencyCode: 'USD', exchangeRate: 18.5 });
  const cn = crypto.randomUUID();
  await pool.query(
    `INSERT INTO credit_notes(id, company_id, credit_note_number, type, credit_date, subtotal, tax_amount, total_amount,
       status, currency, created_by) VALUES($1,$2,$3,'customer',DATE '2026-09-01',100,15,115,'draft','USD',$4)`,
    [cn, c, `CN-${cn.slice(0, 8)}`, user]);
  await pool.query('UPDATE companies SET fx_documents_enabled = false WHERE id = $1', [c]);
  return { c, inv: inv.id, bill: bill.id, cn };
}
async function journal(c: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO gl_journal_entries(company_id, entry_date, description, source, status, created_by)
     VALUES($1, DATE '2026-09-01', 'fx pr0', 'manual', 'draft', $2) RETURNING id`, [c, user]);
  return rows[0].id as string;
}
const DISABLED = /FX_DOCUMENTS_DISABLED/;

describe('a legacy foreign document cannot be posted once the switch is off', () => {
  it('entering the posted population is refused for all three, as app_user and as the owner role', async () => {
    const { c, inv, bill, cn } = await legacy();
    await expect(pool.query("UPDATE customer_invoices SET status = 'approved' WHERE id = $1", [inv])).rejects.toThrow(DISABLED);
    await expect(asAppUser(pool, user, c, (db) => db.query("UPDATE customer_invoices SET status = 'sent' WHERE id = $1", [inv])))
      .rejects.toThrow(DISABLED);
    await expect(pool.query("UPDATE supplier_invoices SET status = 'approved' WHERE id = $1", [bill])).rejects.toThrow(DISABLED);
    await expect(pool.query("UPDATE credit_notes SET status = 'approved' WHERE id = $1", [cn])).rejects.toThrow(DISABLED);
  });

  it('taking a journal link is refused, even with the status unchanged', async () => {
    const { c, inv, bill, cn } = await legacy();
    const je = await journal(c);
    for (const table of ['customer_invoices', 'supplier_invoices', 'credit_notes']) {
      const id = table === 'customer_invoices' ? inv : table === 'supplier_invoices' ? bill : cn;
      await expect(pool.query(`UPDATE ${table} SET gl_journal_entry_id = $2 WHERE id = $1`, [id, je]), table).rejects.toThrow(DISABLED);
    }
  });

  it("cancelling it, or an edit outside the gate's columns, passes; converting it to ZAR passes", async () => {
    const { inv, bill, cn } = await legacy();
    await pool.query("UPDATE customer_invoices SET notes = 'kept', currency_code = 'USD' WHERE id = $1", [inv]);
    await pool.query("UPDATE customer_invoices SET status = 'cancelled' WHERE id = $1", [inv]);
    await pool.query("UPDATE supplier_invoices SET currency = 'ZAR', currency_code = 'ZAR', exchange_rate = 1 WHERE id = $1", [bill]);
    await pool.query("UPDATE supplier_invoices SET status = 'approved' WHERE id = $1", [bill]);
    await pool.query("UPDATE credit_notes SET status = 'cancelled' WHERE id = $1", [cn]);
  });

  it('the switch on again, it posts (PR4 territory, gated by the switch alone)', async () => {
    const { c, inv } = await legacy();
    await enableFxDocuments(pool, c);
    await pool.query("UPDATE customer_invoices SET status = 'approved' WHERE id = $1", [inv]);
  });
});

describe('the switch itself', () => {
  it('app_user cannot move it, though its policy lets it update the row; the owner role can', async () => {
    const c = await newCompany(pool, [[user, 'owner']], companies);
    const renamed = await asAppUser(pool, user, c, (db) => db.query("UPDATE companies SET name = 'fx renamed' WHERE id = $1", [c]));
    expect(renamed.rowCount).toBe(1);
    await expect(asAppUser(pool, user, c, (db: PoolClient) => db.query('UPDATE companies SET fx_documents_enabled = true WHERE id = $1', [c])))
      .rejects.toThrow(/FX_SWITCH_REFUSED/);
    await enableFxDocuments(pool, c);
    expect((await pool.query('SELECT fx_documents_enabled FROM companies WHERE id = $1', [c])).rows[0].fx_documents_enabled).toBe(true);
  });
});

describe('blank is the functional currency in the database too', () => {
  it('a blank currency_code or currency is written with the switch off', async () => {
    const c = await newCompany(pool, [[user, 'owner']], companies);
    await plantInvoice(pool, c, user, { currencyCode: ' ' });
    const bill = await plantBill(pool, c, user);
    await pool.query("UPDATE supplier_invoices SET currency = ' ', currency_code = '' WHERE id = $1", [bill.id]);
    await pool.query('UPDATE supplier_invoices SET amount_paid = 1 WHERE id = $1', [bill.id]);
  });
});

describe('the supplier settlement arms', () => {
  it("an importer's non-zero amount_paid on a foreign bill is refused; zero passes", async () => {
    const c = await newCompany(pool, [[user, 'owner']], companies);
    await enableFxDocuments(pool, c);
    const supplier = crypto.randomUUID();
    await pool.query('INSERT INTO suppliers(id, company_id, name) VALUES($1,$2,$3)', [supplier, c, 'fx importer']);
    const insert = (paid: number) => pool.query(
      `INSERT INTO supplier_invoices(company_id, invoice_number, supplier_id, invoice_date, subtotal, tax_amount, total_amount,
         amount_paid, currency_code, exchange_rate, status, created_by)
       VALUES($1,$2,$3,DATE '2026-09-01',100,15,115,$4,'USD',18.5,'draft',$5)`, [c, `IMP-${crypto.randomUUID().slice(0, 8)}`, supplier, paid, user]);
    await expect(insert(115)).rejects.toThrow(/FX_SETTLEMENT_REFUSED/);
    await insert(0);
  });

  it('a no-op amount_paid UPDATE on a foreign bill passes', async () => {
    const c = await newCompany(pool, [[user, 'owner']], companies);
    await enableFxDocuments(pool, c);
    const bill = await plantBill(pool, c, user, { currencyCode: 'USD', exchangeRate: 18.5 });
    await pool.query('UPDATE supplier_invoices SET amount_paid = amount_paid, notes = $2 WHERE id = $1', [bill.id, 'x']);
  });
});

describe('the migration itself', () => {
  async function inRollback(fn: (db: PoolClient) => Promise<void>): Promise<void> {
    const db = await pool.connect();
    try { await db.query('BEGIN'); await fn(db); } finally { await db.query('ROLLBACK'); db.release(); }
  }

  it('names a company its CHECK would reject, before the CHECK', async () => {
    await inRollback(async (db) => {
      await db.query('ALTER TABLE companies DROP CONSTRAINT companies_functional_currency_zar');
      const c = crypto.randomUUID();
      await db.query("INSERT INTO companies(id, name, functional_currency) VALUES($1, 'fx usd co', 'USD')", [c]);
      await expect(db.query(MIGRATION)).rejects.toThrow(new RegExp(`functional_currency other than ZAR .*${c}=USD`));
    });
  });

  it('names a bank account its CHECK would reject', async () => {
    await inRollback(async (db) => {
      await db.query('ALTER TABLE bank_accounts DROP CONSTRAINT bank_accounts_currency_zar');
      const c = await newCompany(db, []);
      const { rows } = await db.query(
        "INSERT INTO bank_accounts(company_id, account_name, account_number, bank_name, account_type, currency) VALUES($1,'FX','1','FNB','cheque','USD') RETURNING id", [c]);
      await expect(db.query(MIGRATION)).rejects.toThrow(new RegExp(`bank_accounts not in ZAR .*${String(rows[0].id)}=USD`));
    });
  });

  it('re-runs cleanly, bounding its locks at 5s', async () => {
    await inRollback(async (db) => {
      await db.query(MIGRATION);
      expect((await db.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('5s');
    });
  });
});
