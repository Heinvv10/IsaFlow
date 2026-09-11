// The capture post-expense route, against the real ledger.
//
// Two round-2 findings live here and neither is visible from the pure builder:
//
//   - The EMPLOYEE branch. Only the anonymous branch was denied; a receipt
//     posted with an employeeId put the machine-derived VAT on the claim line,
//     and expenseClaimService.postClaim debits VAT Input with the sum of those
//     — the same s17(2)(a) claim through a different table.
//   - The petty-cash branch had no balance pre-check, so an extraction whose
//     three figures disagree reached createJournalEntry and surfaced as a 500
//     on a document that is merely mis-extracted.
//
// Adjacent: a claimable account must keep its VAT, and another tenant's event
// must be refused with nothing written.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import route from '../../pages/api/accounting/capture/[id]/post-expense';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const user = crypto.randomUUID();
const employee = crypto.randomUUID();
const bank = crypto.randomUUID();
const vatInput = crypto.randomUUID();
const defaultExpense = crypto.randomUUID();
const entertainment = crypto.randomUUID();
const stationery = crypto.randomUUID();

const deniedDoc = crypto.randomUUID();
const claimableDoc = crypto.randomUUID();
const unbalancedDoc = crypto.randomUUID();
const tenantDoc = crypto.randomUUID();
const documents = [deniedDoc, claimableDoc, unbalancedDoc, tenantDoc];

const deniedEvent = crypto.randomUUID();
const claimableEvent = crypto.randomUUID();
const unbalancedEvent = crypto.randomUUID();
const tenantEvent = crypto.randomUUID();
const events = [deniedEvent, claimableEvent, unbalancedEvent, tenantEvent];

const today = new Date().toISOString().slice(0, 10);
let token = '';

interface Extract { vendorName: string; subtotal: number | null; vatAmount: number | null; total: number }
const extracted = (e: Extract) => ({
  documentType: 'receipt', vendorName: e.vendorName, date: today, referenceNumber: 'REC-K072B',
  currency: 'ZAR', subtotal: e.subtotal, vatAmount: e.vatAmount, vatRate: 15, totalAmount: e.total,
  lineItems: [], rawText: '', confidence: 0.9, warnings: [], extractionMethod: 'vlm',
});

async function seed(docId: string, eventId: string, owner: string, e: Extract): Promise<void> {
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status)
     VALUES($1,$2,$3,'application/pdf','receipt',$4::jsonb,'pending')`,
    [docId, owner, `k072b-${docId}.pdf`, JSON.stringify(extracted(e))],
  );
  await pool.query(
    `INSERT INTO capture_events(id,company_id,channel,status,captured_document_id)
     VALUES($1,$2,'pwa','extracted',$3)`,
    [eventId, owner, docId],
  );
}

async function post(eventId: string, body: Record<string, unknown>) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST', eventId);
  req.url = `/api/accounting/capture/${eventId}/post-expense`;
  req.body = body;
  const result = response();
  await route(req, result.res);
  return result;
}

async function claimLines(documentId: string) {
  return (await pool.query(
    `SELECT amount::numeric AS amount, vat_amount::numeric AS vat, vat_code, gl_account_id
     FROM expense_claim_lines WHERE company_id=$1 AND source_document_id=$2`,
    [company, documentId],
  )).rows;
}

async function purge(): Promise<void> {
  const companies = [company, otherCompany];
  await pool.query('DELETE FROM capture_events WHERE id=ANY($1::uuid[])', [events]);
  await pool.query('DELETE FROM expense_claim_lines WHERE company_id=ANY($1::uuid[])', [companies]);
  await pool.query('DELETE FROM expense_claims WHERE company_id=ANY($1::uuid[])', [companies]);
  await pool.query('DELETE FROM captured_documents WHERE id=ANY($1::uuid[])', [documents]);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id=ANY($1::uuid[])', [companies]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=ANY($1::uuid[])', [companies]);
  await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])',
    [[bank, vatInput, defaultExpense, entertainment, stationery]]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1::uuid[])', [companies]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id=ANY($1::uuid[])', [companies]);
  await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[])', [companies]);
  await pool.query('DELETE FROM payroll_employees WHERE id=$1', [employee]);
  await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companies]);
  await pool.query('DELETE FROM users WHERE id=$1', [user]);
}

beforeAll(async () => {
  await purge();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K072b owner', otherCompany, 'K072b outsider']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",
    [company, user]);
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,
       employment_type,start_date,status)
     VALUES($1,$2,'K072B-01','Kay','Zeven','permanent',CURRENT_DATE,'active')`,
    [employee, company],
  );
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_system_account,is_active)
     VALUES($1,$6,'K72BB','K072b Bank','asset','bank','debit',true,true),
           ($2,$6,'1140','K072b VAT Input','asset','vat_input','debit',true,true),
           ($3,$6,'K72BDE','K072b Default expense','expense','default_expense','debit',true,true),
           ($4,$6,'5610','K072b Staff welfare','expense',NULL,'debit',false,true),
           ($5,$6,'5100','K072b Office supplies','expense',NULL,'debit',false,true)`,
    [bank, vatInput, defaultExpense, entertainment, stationery, company],
  );
  // The marker migration 521 sets, on the account the claim will be coded to.
  await pool.query('UPDATE gl_accounts SET vat_input_denied = true WHERE id=$1 AND company_id=$2',
    [entertainment, company]);
  clearSystemAccountCache(company);

  await seed(deniedDoc, deniedEvent, company,
    { vendorName: 'Tashas Melrose Arch', subtotal: 1000, vatAmount: 150, total: 1150 });
  await seed(claimableDoc, claimableEvent, company,
    { vendorName: 'Waltons Stationery', subtotal: 1000, vatAmount: 150, total: 1150 });
  // subtotal + vat = 1160, total = 1150. The three figures are extracted
  // independently, so a slip mixing zero- and standard-rated items does this.
  await seed(unbalancedDoc, unbalancedEvent, company,
    { vendorName: 'Waltons Stationery', subtotal: 1010, vatAmount: 150, total: 1150 });
  await seed(tenantDoc, tenantEvent, otherCompany,
    { vendorName: 'Waltons Stationery', subtotal: 1000, vatAmount: 150, total: 1150 });

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

describe('K-072 the employee claim branch obeys s17(2)(a) too', () => {
  it('puts the gross on the line and claims no VAT on a flagged account', async () => {
    const result = await post(deniedEvent, { employeeId: employee, glAccountId: entertainment });
    expect(result.state.statusCode).toBe(200);

    const lines = await claimLines(deniedDoc);
    expect(lines).toHaveLength(1);
    expect(Number(lines[0].amount)).toBe(1150);
    // The number postClaim would debit VAT Input with. Zero is the fix.
    expect(Number(lines[0].vat)).toBe(0);
    expect(lines[0].vat_code).toBe('none');

    // And the claim header, which is what postClaim actually sums.
    const [claim] = (await pool.query(
      `SELECT total_amount::numeric AS total, total_vat::numeric AS vat
       FROM expense_claims c WHERE c.company_id=$1
         AND EXISTS (SELECT 1 FROM expense_claim_lines l
                     WHERE l.claim_id=c.id AND l.source_document_id=$2)`,
      [company, deniedDoc],
    )).rows;
    expect(Number(claim.total)).toBe(1150);
    expect(Number(claim.vat)).toBe(0);

    // The approver has to be told, or a misclassified merchant is never fixed.
    const body = result.state.body as { data: { inputVatDenied: boolean; warnings: string[] } };
    expect(body.data.inputVatDenied).toBe(true);
    expect(body.data.warnings.join(' ')).toContain('s17(2)(a)');
  });

  it('keeps the claim on an account carrying no denial marker', async () => {
    const result = await post(claimableEvent, { employeeId: employee, glAccountId: stationery });
    expect(result.state.statusCode).toBe(200);

    const lines = await claimLines(claimableDoc);
    expect(lines).toHaveLength(1);
    expect(Number(lines[0].amount)).toBe(1150);
    expect(Number(lines[0].vat)).toBe(150);
    expect(lines[0].vat_code).toBe('standard');

    const body = result.state.body as { data: { inputVatDenied: boolean } };
    expect(body.data.inputVatDenied).toBe(false);
  });

  it('refuses another tenant\'s event and creates no claim', async () => {
    const result = await post(tenantEvent, { employeeId: employee, glAccountId: stationery });
    expect(result.state.statusCode).not.toBe(200);
    expect((await pool.query(
      'SELECT COUNT(*)::int AS n FROM expense_claim_lines WHERE source_document_id=$1', [tenantDoc],
    )).rows[0].n).toBe(0);
  });
});

describe('K-072 the petty-cash branch answers 400 on a mis-extracted receipt', () => {
  it('refuses an extraction whose figures do not balance, and writes nothing', async () => {
    const result = await post(unbalancedEvent, { glAccountId: stationery });
    expect(result.state.statusCode).toBe(400);
    const error = (result.state.body as { error: { message: string } }).error;
    expect(error.message).toContain('does not balance');

    expect((await pool.query(
      'SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE source_document_id=$1', [unbalancedDoc],
    )).rows[0].n).toBe(0);
    // And the capture records are untouched, so a corrected extraction can retry.
    expect((await pool.query(
      'SELECT status FROM capture_events WHERE id=$1', [unbalancedEvent],
    )).rows[0].status).toBe('extracted');
  });
});
