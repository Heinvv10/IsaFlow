// R-105 — a partial source-document claim must roll back through the add-line route.
//
// `claimLineSourceDocuments` throws PartialSourceDocumentClaimError when it
// stamped some slips and not all. The add-line route's catch answers 400 for
// any other error, and withAuth COMMITs a 400, so the route rethrows this one
// to reach a 500. The branch is unreachable while the claim's lock holds, so
// here the claim is replaced by one that stamps the slip and then throws.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

vi.mock('@/modules/accounting/services/expense/claimSourceDocuments', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/expense/claimSourceDocuments')>();
  const { sql } = await import('@/lib/neon');
  return {
    ...real,
    claimLineSourceDocuments: async (companyId: string, lines: ReadonlyArray<{ sourceDocumentId?: string | null }>) => {
      const id = lines.find((l) => l.sourceDocumentId)?.sourceDocumentId;
      if (!id) return;
      await sql`UPDATE captured_documents SET posted_at = NOW() WHERE id = ${id}::uuid AND company_id = ${companyId}`;
      throw new real.PartialSourceDocumentClaimError(1, 2);
    },
  };
});

const { default: claimRoute } = await import('../../pages/api/accounting/expense-claims/[id]');

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const employee = crypto.randomUUID();
const claim = crypto.randomUUID();
const slip = crypto.randomUUID();
let token = '';

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'R105 partial owner']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,employment_type,start_date,status, medical_aid_main_member)
     VALUES($1,$2,'R105P-01','Par','Tial','permanent',CURRENT_DATE,'active', true)`, [employee, company]);
  await pool.query(
    `INSERT INTO expense_claims (id, company_id, employee_id, claim_number, claim_date, status)
     VALUES ($1, $2, $3, 'R105P-1', CURRENT_DATE, 'draft')`, [claim, company, employee]);
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status)
     VALUES($1,$2,'r105p.pdf','application/pdf','receipt','{}'::jsonb,'pending')`, [slip, company]);
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM expense_claim_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM expense_claims WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM captured_documents WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE id=$1', [employee]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('R-105: the add-line route rolls a partial claim back', () => {
  it('answers 5xx, so the stamp written before the error is rolled back', async () => {
    const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as
      { body: unknown; query: Record<string, string>; url: string };
    req.url = `/api/accounting/expense-claims/${claim}`;
    req.query = { id: claim };
    req.body = { lineDate: '2026-09-24', description: 'R105 partial', merchant: null, amount: 115, vatAmount: 15,
      vatCode: 'standard', glAccountId: null, costCentreId: null, projectId: null, sourceDocumentId: slip,
      kmTravelled: null, kmRate: null, mileageFrom: null, mileageTo: null };
    const out = response();
    await claimRoute(req as never, out.res as never);
    const state = out.state as { statusCode: number; body: unknown };
    expect(state.statusCode, JSON.stringify(state.body)).toBeGreaterThanOrEqual(500);
    const row = (await pool.query('SELECT posted_at FROM captured_documents WHERE id=$1', [slip])).rows[0];
    expect(row.posted_at).toBeNull();
  });
});
