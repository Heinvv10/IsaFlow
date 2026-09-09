// K-072 against the real ledger: an entertainment receipt must reach
// gl_journal_lines with NO input-tax claim, and a claimable one must keep its.
//
// The unit test pins the pure builder. This goes through the live route
// (pages/api/accounting/receipt-to-journal.ts), which is where the lines are
// filtered, balance-checked and written — so it also proves the denial does not
// unbalance the journal and that the expense leg carries the gross.
//
// Adjacent cases: a meals receipt whose subtotal/VAT were never extracted (the
// derived-VAT branch), and another tenant's user, who must get nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import route from '../../pages/api/accounting/receipt-to-journal';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const user = crypto.randomUUID();
const bank = crypto.randomUUID();
const vatInput = crypto.randomUUID();
const meals = crypto.randomUUID();
const office = crypto.randomUUID();
const defaultExpense = crypto.randomUUID();

const mealsDoc = crypto.randomUUID();
const officeDoc = crypto.randomUUID();
const derivedDoc = crypto.randomUUID();
const tenantDoc = crypto.randomUUID();
const documents = [mealsDoc, officeDoc, derivedDoc, tenantDoc];

const today = new Date().toISOString().slice(0, 10);

let token = '';

interface Extract { vendorName: string; subtotal: number | null; vatAmount: number | null; total: number }
const extracted = (e: Extract) => ({
  documentType: 'receipt', vendorName: e.vendorName, date: today, referenceNumber: 'REC-K072',
  currency: 'ZAR', subtotal: e.subtotal, vatAmount: e.vatAmount, vatRate: 15, totalAmount: e.total,
  lineItems: [], rawText: '', confidence: 0.9, warnings: [], extractionMethod: 'vlm',
});

async function seedDoc(id: string, ownerCompany: string, e: Extract): Promise<void> {
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status)
     VALUES($1,$2,$3,'application/pdf','receipt',$4::jsonb,'pending')`,
    [id, ownerCompany, `k072-${id}.pdf`, JSON.stringify(extracted(e))],
  );
}

async function post(documentId: string, jwt: string, asCompany: string) {
  const req = request({ 'sb-access-token': jwt, active_company_id: asCompany }, 'POST');
  req.url = '/api/accounting/receipt-to-journal';
  req.body = { documentId };
  const result = response();
  await route(req, result.res);
  return result;
}

/** Every posted leg of the journal this document produced, by account. */
async function legs(documentId: string) {
  const rows = (await pool.query(
    `SELECT jl.gl_account_id, jl.debit::numeric AS dr, jl.credit::numeric AS cr, jl.vat_type
     FROM gl_journal_lines jl
     JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
     WHERE je.company_id = $1 AND je.source_document_id = $2`,
    [company, documentId],
  )).rows;
  return {
    byAccount: new Map(rows.map((r) => [r.gl_account_id, {
      dr: Number(r.dr), cr: Number(r.cr), vatType: r.vat_type as string | null,
    }])),
    totalDebit: rows.reduce((a, r) => a + Number(r.dr), 0),
    totalCredit: rows.reduce((a, r) => a + Number(r.cr), 0),
    count: rows.length,
  };
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K072 owner', otherCompany, 'K072 outsider']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",
    [company, user]);
  // The three system roles the route resolves, plus the two merchant-mapped
  // expense accounts (5600 meals & entertainment, 5100 office supplies) it
  // looks up by CODE.
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_system_account,is_active)
     VALUES($1,$6,'K072B','K072 Bank','asset','bank','debit',true,true),
           ($2,$6,'1140','K072 VAT Input','asset','vat_input','debit',true,true),
           ($3,$6,'K072DE','K072 Default expense','expense','default_expense','debit',true,true),
           ($4,$6,'5600','K072 Meals & entertainment','expense',NULL,'debit',false,true),
           ($5,$6,'5100','K072 Office supplies','expense',NULL,'debit',false,true)`,
    [bank, vatInput, defaultExpense, meals, office, company],
  );
  clearSystemAccountCache(company);

  await seedDoc(mealsDoc, company, { vendorName: 'Spur Steak Ranches Rosebank', subtotal: 1000, vatAmount: 150, total: 1150 });
  await seedDoc(officeDoc, company, { vendorName: 'Waltons Stationery', subtotal: 1000, vatAmount: 150, total: 1150 });
  await seedDoc(derivedDoc, company, { vendorName: 'Nandos Menlyn', subtotal: null, vatAmount: null, total: 460 });
  await seedDoc(tenantDoc, otherCompany, { vendorName: 'Spur Steak Ranches Sandton', subtotal: 1000, vatAmount: 150, total: 1150 });

  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    const companies = [company, otherCompany];
    await pool.query('DELETE FROM captured_documents WHERE id=ANY($1::uuid[])', [documents]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])',
      [[bank, vatInput, defaultExpense, meals, office]]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally {
    clearSystemAccountCache();
    await pool.end();
  }
});

describe('K-072 entertainment input VAT reaches the ledger denied', () => {
  it('posts a restaurant receipt with no VAT-input leg and the gross on the expense', async () => {
    const result = await post(mealsDoc, token, company);
    expect(result.state.statusCode).toBe(200);

    const posted = await legs(mealsDoc);
    // Two legs only: the zero VAT line is dropped before posting.
    expect(posted.count).toBe(2);
    expect(posted.byAccount.get(vatInput)).toBeUndefined();
    expect(posted.byAccount.get(meals)).toEqual({ dr: 1150, cr: 0, vatType: null });
    expect(posted.byAccount.get(bank)).toEqual({ dr: 0, cr: 1150, vatType: null });
    // No line anywhere on the entry touches VAT Input.
    // Balanced, and the expense carries exactly what left the bank.
    expect(posted.totalDebit).toBe(posted.totalCredit);
    expect(posted.byAccount.get(meals)!.dr).toBe(posted.byAccount.get(bank)!.cr);
  });

  it('still claims input VAT on an office-supplies receipt', async () => {
    const result = await post(officeDoc, token, company);
    expect(result.state.statusCode).toBe(200);

    const posted = await legs(officeDoc);
    expect(posted.count).toBe(3);
    expect(posted.byAccount.get(office)).toEqual({ dr: 1000, cr: 0, vatType: null });
    expect(posted.byAccount.get(vatInput)).toEqual({ dr: 150, cr: 0, vatType: null });
    expect(posted.byAccount.get(bank)).toEqual({ dr: 0, cr: 1150, vatType: null });
    expect(posted.totalDebit).toBe(posted.totalCredit);
  });

  it('denies the claim on a meals receipt whose VAT was DERIVED, not extracted', async () => {
    // subtotal and vatAmount are null, so the builder computes 400 + 60 from
    // the 460 total. The denial must key off the receipt type, not off whether
    // a VAT figure was extracted.
    const result = await post(derivedDoc, token, company);
    expect(result.state.statusCode).toBe(200);

    const posted = await legs(derivedDoc);
    expect(posted.byAccount.get(vatInput)).toBeUndefined();
    expect(posted.byAccount.get(meals)!.dr).toBe(460);
    expect(posted.totalDebit).toBe(posted.totalCredit);
  });

  it('refuses another tenant and writes no journal at all', async () => {
    const result = await post(tenantDoc, token, company);
    expect(result.state.statusCode).not.toBe(200);
    expect((await pool.query(
      'SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE source_document_id=$1', [tenantDoc],
    )).rows[0].n).toBe(0);
  });
});
