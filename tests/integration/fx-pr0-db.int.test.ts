/**
 * FX PR0, the database half (migration 871).
 *
 * - companies.functional_currency is the one authority: NOT NULL, 'ZAR'.
 * - While a company has not enabled foreign-currency documents, no customer
 *   invoice, supplier invoice or credit note is written in another currency —
 *   as app_user or as the owner role a script runs as.
 * - No amount_paid moves on a foreign-currency invoice or bill, on INSERT or
 *   UPDATE, whoever writes it: the settlement writers are currency-blind and
 *   would add rands to a USD balance.
 * - public.fx_functional and toFunctional agree to the cent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanup, createUser, newCompany, plantBill } from './r035-approval.helpers';
import { asAppUser, plantInvoice } from './r035-pr4.helpers';
import { toFunctional } from '@/modules/accounting/services/shared/functionalAmounts';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';

beforeAll(async () => { user = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM credit_notes WHERE company_id = ANY($1)', [companies]);
  await cleanup(pool, companies, [user]);
});

async function company(fxEnabled = false): Promise<string> {
  const c = await newCompany(pool, [[user, 'owner']], companies);
  if (fxEnabled) await pool.query('UPDATE companies SET fx_documents_enabled = true WHERE id = $1', [c]);
  return c;
}
const disable = (c: string) => pool.query('UPDATE companies SET fx_documents_enabled = false WHERE id = $1', [c]);
const asApp = <T>(c: string, fn: (client: PoolClient) => Promise<T>) => asAppUser(pool, user, c, fn);
const DISABLED = /FX_DOCUMENTS_DISABLED/;
const REFUSED = /FX_SETTLEMENT_REFUSED/;

async function creditNote(db: Pool | PoolClient, c: string, currency: string | null): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO credit_notes(id, company_id, credit_note_number, type, credit_date, subtotal, tax_amount, total_amount,
       status, currency, created_by)
     VALUES($1,$2,$3,'customer',DATE '2026-09-01',100,15,115,'draft',$4,$5)`,
    [id, c, `CN-${id.slice(0, 8)}`, currency, user]);
  return id;
}

describe('the functional currency', () => {
  it('is NOT NULL, defaults to ZAR and may be nothing else', async () => {
    const c = await company();
    expect((await pool.query('SELECT functional_currency, fx_documents_enabled FROM companies WHERE id = $1', [c])).rows)
      .toEqual([{ functional_currency: 'ZAR', fx_documents_enabled: false }]);
    await expect(pool.query("UPDATE companies SET functional_currency = 'USD' WHERE id = $1", [c]))
      .rejects.toThrow(/companies_functional_currency_zar/);
    await expect(pool.query('UPDATE companies SET functional_currency = NULL WHERE id = $1', [c])).rejects.toThrow(/null value/);
  });

  it('a vestigial bank_accounts row cannot be foreign', async () => {
    await expect(pool.query(
      `INSERT INTO bank_accounts(company_id, account_name, account_number, bank_name, account_type, currency)
       VALUES($1,'FX','1','FNB','cheque','USD')`, [await company()])).rejects.toThrow(/bank_accounts_currency_zar/);
  });

  it('the definer functions are owned by a role that bypasses RLS', async () => {
    const { rows } = await pool.query(
      `SELECT p.proname, (r.rolbypassrls OR r.rolsuper) AS bypasses FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.proname IN ('fx_row_is_foreign','fx_document_currency_gate','fx_settlement_refusal') ORDER BY 1`);
    expect(rows.map((r) => [r.proname, r.bypasses])).toEqual(
      [['fx_document_currency_gate', true], ['fx_row_is_foreign', true], ['fx_settlement_refusal', true]]);
  });
});

describe('foreign-currency documents are refused while the company has not enabled them', () => {
  it('a USD customer invoice: INSERT as app_user and as the owner role, and an UPDATE into USD', async () => {
    const c = await company();
    await expect(asApp(c, (db) => plantInvoice(db, c, user, { currencyCode: 'USD', exchangeRate: 18.5 }))).rejects.toThrow(DISABLED);
    await expect(plantInvoice(pool, c, user, { currencyCode: 'USD', exchangeRate: 18.5 })).rejects.toThrow(DISABLED);
    const zar = await plantInvoice(pool, c, user);
    await expect(pool.query("UPDATE customer_invoices SET currency_code = 'EUR' WHERE id = $1", [zar.id])).rejects.toThrow(DISABLED);
    expect((await pool.query('SELECT currency_code FROM customer_invoices WHERE id = $1', [zar.id])).rows[0].currency_code).toBe('ZAR');
  });

  it('the functional currency in lower case, and NULL, pass', async () => {
    const c = await company();
    await plantInvoice(pool, c, user, { currencyCode: 'zar' });
    const id = (await plantInvoice(pool, c, user)).id;
    await pool.query('UPDATE customer_invoices SET currency_code = NULL WHERE id = $1', [id]);
  });

  it('a supplier bill is foreign if EITHER currency column is', async () => {
    const c = await company();
    await expect(plantBill(pool, c, user, { currencyCode: 'USD', exchangeRate: 18.5 })).rejects.toThrow(DISABLED);
    const bill = await plantBill(pool, c, user);
    await expect(pool.query("UPDATE supplier_invoices SET currency = 'GBP' WHERE id = $1", [bill.id])).rejects.toThrow(DISABLED);
    await expect(asApp(c, (db) => db.query("UPDATE supplier_invoices SET currency_code = 'GBP' WHERE id = $1", [bill.id])))
      .rejects.toThrow(DISABLED);
  });

  it('a credit note in another currency', async () => {
    const c = await company();
    await expect(creditNote(pool, c, 'USD')).rejects.toThrow(DISABLED);
    const cn = await creditNote(pool, c, 'ZAR');
    await expect(pool.query("UPDATE credit_notes SET currency = 'EUR' WHERE id = $1", [cn])).rejects.toThrow(DISABLED);
  });

  it('enabled, all three are written; disabled again, an existing one still takes edits that leave its currency alone', async () => {
    const c = await company(true);
    const inv = await plantInvoice(pool, c, user, { currencyCode: 'USD', exchangeRate: 18.5 });
    const bill = await plantBill(pool, c, user, { currencyCode: 'EUR', exchangeRate: 20 });
    const cn = await creditNote(pool, c, 'GBP');
    await disable(c);
    await pool.query("UPDATE customer_invoices SET notes = 'kept' WHERE id = $1", [inv.id]);
    await pool.query("UPDATE supplier_invoices SET notes = 'kept' WHERE id = $1", [bill.id]);
    await pool.query("UPDATE credit_notes SET reason = 'kept' WHERE id = $1", [cn]);
  });
});

describe('amount_paid never moves on a foreign-currency invoice or bill', () => {
  it('UPDATE, up or down, as app_user and as the owner role; the balance is untouched', async () => {
    const c = await company(true);
    const inv = await plantInvoice(pool, c, user, { currencyCode: 'USD', exchangeRate: 18.5 });
    await expect(pool.query('UPDATE customer_invoices SET amount_paid = 100 WHERE id = $1', [inv.id])).rejects.toThrow(REFUSED);
    await expect(asApp(c, (db) => db.query('UPDATE customer_invoices SET amount_paid = amount_paid + 1 WHERE id = $1', [inv.id])))
      .rejects.toThrow(REFUSED);
    expect(Number((await pool.query('SELECT amount_paid FROM customer_invoices WHERE id = $1', [inv.id])).rows[0].amount_paid)).toBe(0);
  });

  it('an UPDATE that names amount_paid without changing it, or changes other columns, passes', async () => {
    const c = await company(true);
    const inv = await plantInvoice(pool, c, user, { currencyCode: 'USD', exchangeRate: 18.5 });
    await pool.query('UPDATE customer_invoices SET amount_paid = amount_paid, notes = $2 WHERE id = $1', [inv.id, 'x']);
  });

  it('a ZAR invoice settles as before', async () => {
    const c = await company(true);
    const inv = await plantInvoice(pool, c, user);
    await pool.query('UPDATE customer_invoices SET amount_paid = 100 WHERE id = $1', [inv.id]);
    await pool.query('UPDATE customer_invoices SET amount_paid = 0 WHERE id = $1', [inv.id]);
  });

  it('INSERT with a non-zero amount_paid (an importer) is refused; zero passes', async () => {
    const c = await company(true);
    const customer = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES($1,$2,$3)', [customer, c, 'fx importer']);
    const insert = (paid: number) => pool.query(
      `INSERT INTO customer_invoices(company_id, invoice_number, customer_id, client_id, subtotal, tax_amount, total_amount,
         amount_paid, currency_code, exchange_rate, status, created_by)
       VALUES($1,$2,$3,$3,100,15,115,$4,'USD',18.5,'draft',$5)`, [c, `IMP-${crypto.randomUUID().slice(0, 8)}`, customer, paid, user]);
    await expect(insert(115)).rejects.toThrow(REFUSED);
    await insert(0);
  });

  it('a bill foreign in either column is refused; a ZAR bill settles', async () => {
    const c = await company(true);
    const usd = await plantBill(pool, c, user, { currencyCode: 'USD', exchangeRate: 18.5 });
    await expect(pool.query('UPDATE supplier_invoices SET amount_paid = 10 WHERE id = $1', [usd.id])).rejects.toThrow(REFUSED);
    const legacy = await plantBill(pool, c, user);
    await pool.query("UPDATE supplier_invoices SET currency = 'USD' WHERE id = $1", [legacy.id]);
    await expect(asApp(c, (db) => db.query('UPDATE supplier_invoices SET amount_paid = 10 WHERE id = $1', [legacy.id])))
      .rejects.toThrow(REFUSED);
    const zar = await plantBill(pool, c, user);
    await pool.query('UPDATE supplier_invoices SET amount_paid = 10 WHERE id = $1', [zar.id]);
  });
});

describe('public.fx_functional and toFunctional agree', () => {
  it('on every half-cent edge and 10,000 random pairs', async () => {
    const pairs: [string, string][] = [
      ['1.005', '1'], ['1.25', '0.5'], ['-1.25', '0.5'], ['0.125', '1'], ['-0.125', '1'], ['4.35', '100'],
      ['100.00', '18.333'], ['5.00', '18.333'], ['9999999999999.99', '1'], ['0.01', '0.000001'], ['0.00', '18.5'],
    ];
    for (let i = 0; i < 10_000; i++) {
      const cents = Math.floor(Math.random() * 2e9) - 1e9;
      const micro = Math.floor(Math.random() * 250e6) + 1;
      pairs.push([(cents / 100).toFixed(2), (micro / 1e6).toFixed(6)]);
    }
    const { rows } = await pool.query<{ f: string }>(
      'SELECT public.fx_functional(a::numeric, r::numeric)::text AS f FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS t(a, r, n) ORDER BY n',
      [pairs.map((p) => p[0]), pairs.map((p) => p[1])]);
    const mismatches = pairs.filter(([a, r], i) => toFunctional(a, r) !== Number(rows[i]!.f)).slice(0, 5);
    expect(mismatches).toEqual([]);
  });
});
