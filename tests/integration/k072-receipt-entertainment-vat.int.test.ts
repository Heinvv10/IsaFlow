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
const flagged = crypto.randomUUID();
const defaultExpense = crypto.randomUUID();

const mealsDoc = crypto.randomUUID();
const officeDoc = crypto.randomUUID();
const derivedDoc = crypto.randomUUID();
const tenantDoc = crypto.randomUUID();
const flaggedDoc = crypto.randomUUID();
const spurwayDoc = crypto.randomUUID();
const wimpyDoc = crypto.randomUUID();
const spurTextDoc = crypto.randomUUID();
const documents = [mealsDoc, officeDoc, derivedDoc, tenantDoc, flaggedDoc, spurwayDoc, wimpyDoc, spurTextDoc];

const today = new Date().toISOString().slice(0, 10);

let token = '';

interface Extract { vendorName: string; subtotal: number | null; vatAmount: number | null; total: number; rawText?: string; confidence?: number }
const extracted = (e: Extract) => ({
  documentType: 'receipt', vendorName: e.vendorName, date: today, referenceNumber: 'REC-K072',
  currency: 'ZAR', subtotal: e.subtotal, vatAmount: e.vatAmount, vatRate: 15, totalAmount: e.total,
  lineItems: [], rawText: e.rawText ?? '', confidence: e.confidence ?? 0.9, warnings: [], extractionMethod: 'vlm',
});
/** A slip the unattended gate accepts (printed VAT, one total, paid by card), so the route auto-posts it. */
const printed = (vendor: string, item: string) => ({ vendorName: vendor, subtotal: 869.57, vatAmount: 130.43, total: 1000, confidence: 0.99,
  rawText: `${vendor}\nTAX INVOICE\nVAT No 4987654321\nDate: ${today}\n${item} 1000.00\nSubtotal 869.57\nVAT 130.43\nTOTAL 1000.00\nCARD 1000.00\n` });

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

/**
 * Cleanup runs at BOTH ends. `afterAll` alone leaves the tenant rows behind
 * whenever a run is interrupted or `beforeAll` itself throws, and the fixture
 * database is shared with every other integration file — a stale `companies`
 * row from a killed run is somebody else's confusing failure later.
 */
async function purge(): Promise<void> {
  const companies = [company, otherCompany];
  await pool.query('DELETE FROM captured_documents WHERE id=ANY($1::uuid[])', [documents]);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id=ANY($1::uuid[])', [companies]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=ANY($1::uuid[])', [companies]);
  await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])',
    [[bank, vatInput, defaultExpense, meals, office, flagged]]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1::uuid[])', [companies]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id=ANY($1::uuid[])', [companies]);
  await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[])', [companies]);
  await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companies]);
  await pool.query('DELETE FROM users WHERE id=$1', [user]);
}

beforeAll(async () => {
  await purge();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K072 owner', otherCompany, 'K072 outsider']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",
    [company, user]);
  // The three system roles the route resolves, plus the merchant-mapped expense
  // accounts (5600 meals & entertainment, 5100 office supplies) it looks up by
  // CODE, plus a flagged Staff Welfare account for the account-marker case.
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_system_account,is_active)
     VALUES($1,$7,'K072B','K072 Bank','asset','bank','debit',true,true),
           ($2,$7,'1140','K072 VAT Input','asset','vat_input','debit',true,true),
           ($3,$7,'K072DE','K072 Default expense','expense','default_expense','debit',true,true),
           ($4,$7,'5600','Administrative Expenses','expense','admin_expense','debit',true,true),
           ($5,$7,'5100','K072 Office supplies','expense',NULL,'debit',false,true),
           ($6,$7,'5610','K072 Staff welfare','expense',NULL,'debit',false,true)`,
    [bank, vatInput, defaultExpense, meals, office, flagged, company],
  );
  // 5600 is the SEEDED row, as migrations 200/476/605 create it: `Administrative
  // Expenses`, which migration 521's name rule does not flag (K-072 r36: round 35
  // renamed and flagged it here, a chart no company has). Only the Staff welfare
  // account carries the marker migration 521 sets.
  await pool.query('UPDATE gl_accounts SET vat_input_denied = true WHERE id=$1 AND company_id=$2',
    [flagged, company]);
  clearSystemAccountCache(company);

  await seedDoc(mealsDoc, company, { vendorName: 'Spur Steak Ranches Rosebank', subtotal: 1000, vatAmount: 150, total: 1150 });
  await seedDoc(officeDoc, company, { vendorName: 'Waltons Stationery', subtotal: 1000, vatAmount: 150, total: 1150 });
  await seedDoc(derivedDoc, company, { vendorName: 'Nandos Menlyn', subtotal: null, vatAmount: null, total: 460 });
  await seedDoc(tenantDoc, otherCompany, { vendorName: 'Spur Steak Ranches Sandton', subtotal: 1000, vatAmount: 150, total: 1150 });
  await seedDoc(flaggedDoc, company, { vendorName: 'Tashas Melrose Arch', subtotal: 1000, vatAmount: 150, total: 1150 });
  await seedDoc(spurwayDoc, company, printed('Spurway Steel', 'Flat bar 50x6 6m'));
  await seedDoc(wimpyDoc, company, printed('Wimpy Linden', 'Burger meal'));
  await seedDoc(spurTextDoc, company, printed('Spur Steak Ranches Rosebank', 'Platter'));

  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

// 60s, explicitly: the default 10s hook budget was exceeded on a loaded shared
// fixture database, so the file passed every assertion and still exited 1 with
// its rows left behind for the next run to trip over.
afterAll(async () => {
  try {
    await purge();
  } finally {
    clearSystemAccountCache();
    await pool.end();
  }
}, 60_000);

describe('K-072 entertainment input VAT reaches the ledger denied', () => {
  it('on the seeded chart a restaurant receipt keeps its VAT claim, and is HELD for a person: a marked draft', async () => {
    // 5600 `Administrative Expenses` does not deny input VAT, and the vendor name
    // folds nothing (K-072 r35). So the draft claims — and is held (r36).
    const result = await post(mealsDoc, token, company);
    expect(result.state.statusCode).toBe(200);
    const posted = await legs(mealsDoc);
    expect(posted.byAccount.get(vatInput)).toEqual({ dr: 150, cr: 0, vatType: 'standard' });
    expect(posted.byAccount.get(meals)!.dr).toBe(1000);
    const { rows } = await pool.query('SELECT status, description FROM gl_journal_entries WHERE company_id=$1 AND source_document_id=$2',
      [company, mealsDoc]);
    expect(rows[0].status).toBe('draft');
    expect(rows[0].description).toMatch(/HELD for a person/);
    expect(posted.totalDebit).toBe(posted.totalCredit);
  });

  it('still claims input VAT on an office-supplies receipt', async () => {
    const result = await post(officeDoc, token, company);
    expect(result.state.statusCode).toBe(200);

    const posted = await legs(officeDoc);
    expect(posted.count).toBe(3);
    // Tagged 'standard' in the ledger, which is also what puts this route
    // inside the scope of scripts/ci/check-vat-guard-coverage.ts.
    expect(posted.byAccount.get(office)).toEqual({ dr: 1000, cr: 0, vatType: 'standard' });
    expect(posted.byAccount.get(vatInput)).toEqual({ dr: 150, cr: 0, vatType: 'standard' });
    expect(posted.byAccount.get(bank)).toEqual({ dr: 0, cr: 1150, vatType: null });
    expect(posted.totalDebit).toBe(posted.totalCredit);
  });

  it('denies the claim on a meals receipt whose VAT was DERIVED, not extracted', async () => {
    // subtotal and vatAmount are null. Since K-072 r31 the builder claims no
    // VAT at all when none was read (it used to derive 400 + 60 from the 460),
    // so the meals account carries the gross either way — and the denial still
    // keys off the receipt type, not off whether a VAT figure was extracted.
    const result = await post(derivedDoc, token, company);
    expect(result.state.statusCode).toBe(200);

    const posted = await legs(derivedDoc);
    expect(posted.byAccount.get(vatInput)).toBeUndefined();
    expect(posted.byAccount.get(meals)!.dr).toBe(460);
    expect(posted.totalDebit).toBe(posted.totalCredit);
  });

  it('denies on the ACCOUNT flag when the merchant map does not know the vendor', async () => {
    // "Tashas" is not in MERCHANT_PATTERNS, so it maps to the default expense
    // account and classifies as `general`. Nothing in the builder can deny it.
    // The route reads gl_accounts.vat_input_denied on the account it resolved,
    // which is the marker migration 521 exists to set.
    await pool.query(
      'UPDATE gl_accounts SET vat_input_denied = true WHERE id=$1 AND company_id=$2',
      [defaultExpense, company],
    );
    const result = await post(flaggedDoc, token, company);
    expect(result.state.statusCode).toBe(200);

    const posted = await legs(flaggedDoc);
    expect(posted.byAccount.get(vatInput)).toBeUndefined();
    expect(posted.byAccount.get(defaultExpense)!.dr).toBe(1150);
    expect(posted.totalDebit).toBe(posted.totalCredit);
  });

  it('refuses a SECOND post of a document it already journalised', async () => {
    // The handler stamps the document 'matched' and used to refuse nothing, so
    // a double-click or a client retry posted the same receipt twice — the
    // expense and the bank credit doubled against one source document.
    const before = (await pool.query(
      'SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source_document_id=$2',
      [company, mealsDoc],
    )).rows[0].n;
    expect(before).toBe(1);

    const repeat = await post(mealsDoc, token, company);
    expect(repeat.state.statusCode).toBe(400);

    expect((await pool.query(
      'SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source_document_id=$2',
      [company, mealsDoc],
    )).rows[0].n).toBe(before);
    // And the ledger is unchanged: still the two legs of the first post.
    expect((await legs(mealsDoc)).count).toBe(3);
  });

  it('refuses another tenant and writes no journal at all', async () => {
    const result = await post(tenantDoc, token, company);
    expect(result.state.statusCode).not.toBe(200);
    expect((await pool.query(
      'SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE source_document_id=$1', [tenantDoc],
    )).rows[0].n).toBe(0);
  });
});

describe('K-072 r35 — the vendor name folds nothing; the account does', () => {
  const status = async (doc: string) => (await pool.query(
    'SELECT status FROM gl_journal_entries WHERE company_id=$1 AND source_document_id=$2', [company, doc])).rows[0]?.status;

  it('Spurway Steel auto-posts claiming its R130.43: `spur` is not a word in its name', async () => {
    // The ACCOUNT-flag case above leaves the default expense account denying; Spurway books there, so clear it.
    await pool.query('UPDATE gl_accounts SET vat_input_denied = false WHERE id=$1 AND company_id=$2', [defaultExpense, company]);
    expect((await post(spurwayDoc, token, company)).state.statusCode).toBe(200);
    const posted = await legs(spurwayDoc);
    expect(await status(spurwayDoc)).toBe('posted');
    expect(posted.byAccount.get(vatInput)).toEqual({ dr: 130.43, cr: 0, vatType: 'standard' });
    expect(posted.byAccount.get(defaultExpense)!.dr).toBe(869.57);
  });

  it('Spur on an account the TENANT flagged as denying folds the VAT, and auto-posts', async () => {
    // A tenant choice, made here explicitly and undone: the seeded 5600 is not flagged.
    await pool.query('UPDATE gl_accounts SET vat_input_denied = true WHERE id=$1 AND company_id=$2', [meals, company]);
    try {
      expect((await post(spurTextDoc, token, company)).state.statusCode).toBe(200);
      expect(await status(spurTextDoc)).toBe('posted');
      expect((await legs(spurTextDoc)).byAccount.get(meals)).toEqual({ dr: 1000, cr: 0, vatType: 'no_vat' });
    } finally {
      await pool.query('UPDATE gl_accounts SET vat_input_denied = false WHERE id=$1 AND company_id=$2', [meals, company]);
    }
  });

  it('a meals merchant on the seeded, unflagged 5600 is left a draft for a person, its VAT not folded', async () => {
    expect((await post(wimpyDoc, token, company)).state.statusCode).toBe(200);
    expect(await status(wimpyDoc)).toBe('draft');
    expect((await legs(wimpyDoc)).byAccount.get(vatInput)!.dr).toBe(130.43);
  });
});
