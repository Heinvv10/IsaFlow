// What a DENIED expense claim leaves in the ledger, and what the people who
// edit and approve it are told — against the real database.
//
// Two gaps around the s17(2)(a) denial on the claim branch:
//
//   - `postClaim` pushed its expense legs with no `vatType`, so a denied claim
//     reached gl_journal_lines with vat_type = NULL. That is the state the
//     denial argues against: an exception report cannot tell "s17(2)(a) took
//     the claim" from "nobody classified this line". The petty-cash branch
//     already records 'no_vat'; the claim branch did not.
//   - The denial is resolved once, when the claim is created. After that
//     `PATCH .../lines/[lineId]` writes vat_amount and vat_code with no advice
//     at all, and `approve` said nothing either — so an approver could restore
//     the R150 on a flagged account and never see the warning.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import approveRoute from '../../pages/api/accounting/expense-claims/[id]/approve';
import claimsRoute from '../../pages/api/accounting/expense-claims/index';
import lineRoute from '../../pages/api/accounting/expense-claims/[id]/lines/[lineId]';
import postRoute from '../../pages/api/accounting/expense-claims/[id]/post';
import submitRoute from '../../pages/api/accounting/expense-claims/[id]/submit';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const user = crypto.randomUUID();
const employee = crypto.randomUUID();
const vatInput = crypto.randomUUID();
const entertainment = crypto.randomUUID();
const reimbursement = crypto.randomUUID();

const today = new Date().toISOString().slice(0, 10);
let token = '';

function call(
  route: (req: never, res: never) => Promise<unknown>,
  url: string,
  query: Record<string, string>,
  body: Record<string, unknown>,
) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST');
  req.url = url;
  (req as unknown as { query: Record<string, string> }).query = query;
  req.body = body;
  const result = response();
  return (route as unknown as (a: unknown, b: unknown) => Promise<unknown>)(req, result.res)
    .then(() => result);
}

function patchLine(claimId: string, lineId: string, body: Record<string, unknown>) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'PATCH');
  req.url = `/api/accounting/expense-claims/${claimId}/lines/${lineId}`;
  (req as unknown as { query: Record<string, string> }).query = { id: claimId, lineId };
  req.body = body;
  const result = response();
  return (lineRoute as unknown as (a: unknown, b: unknown) => Promise<unknown>)(req, result.res)
    .then(() => result);
}

interface ClaimBody { data: { claim: { id: string; lines?: Array<{ id: string }> }; warnings?: string[] } }

async function createDraft(vatAmount: number, vatCode: string): Promise<{ claimId: string; lineId: string }> {
  const created = await call(claimsRoute, '/api/accounting/expense-claims', {}, {
    employeeId: employee,
    claimDate: today,
    title: 'K072D entertainment',
    lines: [{
      lineDate: today, description: 'Client lunch', merchant: 'Tashas Melrose Arch',
      amount: 1150, vatAmount, vatCode, glAccountId: entertainment,
    }],
  });
  expect(created.state.statusCode).toBe(201);
  const claim = (created.state.body as ClaimBody).data.claim;
  return { claimId: claim.id, lineId: claim.lines![0]!.id };
}

async function expenseLegs(claimId: string) {
  return (await pool.query(
    `SELECT jl.gl_account_id, jl.debit::numeric AS dr, jl.vat_type
     FROM gl_journal_lines jl
     JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
     WHERE je.company_id=$1 AND je.reference = (SELECT claim_number FROM expense_claims WHERE id=$2)`,
    [company, claimId],
  )).rows;
}

async function purge(): Promise<void> {
  await pool.query('DELETE FROM expense_claim_lines WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM expense_claims WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])',
    [[vatInput, entertainment, reimbursement]]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM payroll_employees WHERE id=$1', [employee]);
  await pool.query('DELETE FROM companies WHERE id=$1', [company]);
  await pool.query('DELETE FROM users WHERE id=$1', [user]);
}

beforeAll(async () => {
  await purge();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K072D owner']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",
    [company, user]);
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,
       employment_type,start_date,status)
     VALUES($1,$2,'K072D-01','Kay','Zeven','permanent',CURRENT_DATE,'active')`,
    [employee, company],
  );
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_system_account,is_active)
     VALUES($1,$4,'1140','K072D VAT Input','asset','vat_input','debit',true,true),
           ($2,$4,'5610','K072D Staff welfare','expense',NULL,'debit',false,true),
           ($3,$4,'2410','K072D Employee reimbursements','liability',NULL,'credit',false,true)`,
    [vatInput, entertainment, reimbursement, company],
  );
  await pool.query('UPDATE gl_accounts SET vat_input_denied = true WHERE id=$1 AND company_id=$2',
    [entertainment, company]);
  clearSystemAccountCache(company);

  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await purge();
  } finally {
    clearSystemAccountCache();
    await pool.end();
  }
});

describe('K-072 a denied claim reaches the ledger classified', () => {
  it('posts the expense leg as no_vat with no VAT-input leg at all', async () => {
    const { claimId } = await createDraft(0, 'none');
    expect((await call(submitRoute, `/api/accounting/expense-claims/${claimId}/submit`,
      { id: claimId }, {})).state.statusCode).toBe(200);
    expect((await call(approveRoute, `/api/accounting/expense-claims/${claimId}/approve`,
      { id: claimId }, { decision: 'approve' })).state.statusCode).toBe(200);
    const posted = await call(postRoute, `/api/accounting/expense-claims/${claimId}/post`,
      { id: claimId }, { reimbursementAccountId: reimbursement, vatInputAccountId: vatInput });
    expect(posted.state.statusCode).toBe(200);

    const legs = await expenseLegs(claimId);
    const expense = legs.find(l => l.gl_account_id === entertainment);
    // The gross on the expense, and 'no_vat' rather than NULL — the denial is a
    // recorded classification, which is what an exception report can read.
    expect(Number(expense.dr)).toBe(1150);
    expect(expense.vat_type).toBe('no_vat');
    // And nothing was debited to VAT Input.
    expect(legs.find(l => l.gl_account_id === vatInput)).toBeUndefined();
  });
});

describe('K-072 the denial stays visible while the claim can still be edited', () => {
  it('warns when an editor puts the VAT back on a flagged line', async () => {
    const { claimId, lineId } = await createDraft(0, 'none');

    // Nothing to say while the line claims nothing.
    const quiet = await patchLine(claimId, lineId, { description: 'Client lunch, Rosebank' });
    expect(quiet.state.statusCode).toBe(200);
    expect((quiet.state.body as ClaimBody).data.warnings).toEqual([]);

    // The edit the denial exists for. `postClaim` sums vat_amount regardless of
    // vat_code, so the amount alone is enough to produce the claim.
    const restored = await patchLine(claimId, lineId, { vatAmount: 150 });
    expect(restored.state.statusCode).toBe(200);
    expect((restored.state.body as ClaimBody).data.warnings!.join(' ')).toContain('s17(2)(a)');
  });

  it('repeats the advice to the approver, who is the last person to see it', async () => {
    const { claimId } = await createDraft(150, 'standard');
    await call(submitRoute, `/api/accounting/expense-claims/${claimId}/submit`, { id: claimId }, {});
    const approved = await call(approveRoute, `/api/accounting/expense-claims/${claimId}/approve`,
      { id: claimId }, { decision: 'approve' });
    expect(approved.state.statusCode).toBe(200);
    expect((approved.state.body as ClaimBody).data.warnings!.join(' ')).toContain('s17(2)(a)');
  });

  it('says nothing on a claim coded to an account carrying no marker', async () => {
    await pool.query('UPDATE gl_accounts SET vat_input_denied = false WHERE id=$1 AND company_id=$2',
      [entertainment, company]);
    try {
      const { claimId, lineId } = await createDraft(150, 'standard');
      const patched = await patchLine(claimId, lineId, { vatAmount: 150 });
      expect((patched.state.body as ClaimBody).data.warnings).toEqual([]);
    } finally {
      await pool.query('UPDATE gl_accounts SET vat_input_denied = true WHERE id=$1 AND company_id=$2',
        [entertainment, company]);
    }
  });
});
