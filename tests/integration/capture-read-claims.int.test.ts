// A document whose upload is still being read has no extraction yet, so nothing may claim it for posting: the capture
// posting claim and a manual expense claim line both refuse it ('being_read', before any write), and claim it
// normally once the read finished or went stale. Real PostgreSQL, real route for the expense claim.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import claimsRoute from '../../pages/api/accounting/expense-claims';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { als } from '@/lib/als';
import { claimCapturedDocumentForPosting } from '@/modules/accounting/services/capture/capturePostingClaim';
import { ClaimSourceDocumentError, claimLineSourceDocuments } from '@/modules/accounting/services/expense/claimSourceDocuments';
import { NOT_READ, STILL_BEING_READ } from '@/modules/accounting/services/capture/captureReadState';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

const company = crypto.randomUUID();
const user = crypto.randomUUID();
const employee = crypto.randomUUID();
const expense = crypto.randomUUID();
const today = new Date().toISOString().slice(0, 10);
let token = '';
const docs: string[] = [];

async function seed(readState: 'reading' | 'done' | 'failed', silentMinutes = 0): Promise<string> {
  const id = crypto.randomUUID();
  docs.push(id);
  await pool.query(
    `INSERT INTO captured_documents(id, company_id, file_name, file_type, document_type, extracted_data, status, read_state, created_at)
     VALUES($1, $2, $3, 'pdf', 'receipt', '{}'::jsonb, 'pending', $4, NOW() - make_interval(mins => $5))`,
    [id, company, `claims-${id}.pdf`, readState, silentMinutes],
  );
  return id;
}
const postedAt = async (id: string) => (await pool.query('SELECT posted_at FROM captured_documents WHERE id=$1', [id])).rows[0].posted_at;

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await als.run({ client: c, userId: user, companyId: company, claims: {} } as never, fn);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally { c.release(); }
}

function line(sourceDocumentId: string) {
  return {
    lineDate: today, description: 'slip', merchant: 'Waltons', amount: 115, vatAmount: 15, vatCode: 'standard',
    glAccountId: expense, costCentreId: null, projectId: null, sourceDocumentId, kmTravelled: null, kmRate: null,
    mileageFrom: null, mileageTo: null,
  };
}
async function createClaim(lines: unknown[]) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.url = '/api/accounting/expense-claims';
  req.query = {};
  req.body = { employeeId: employee, lines };
  const out = response();
  await claimsRoute(req as never, out.res as never);
  return out.state as { statusCode: number; body: { error?: { message?: string } } };
}

async function purge(): Promise<void> {
  await pool.query('DELETE FROM expense_claim_lines WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM expense_claims WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM captured_documents WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM payroll_employees WHERE id=$1', [employee]);
  await pool.query('DELETE FROM companies WHERE id=$1', [company]);
  await pool.query('DELETE FROM users WHERE id=$1', [user]);
}

beforeAll(async () => {
  await purge();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Read claims']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,employment_type,start_date,status, medical_aid_main_member)
     VALUES($1,$2,'RC-01','Read','Claimer','permanent',CURRENT_DATE,'active', true)`, [employee, company]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,is_active)
     VALUES($1,$2,'RCEX','Read claims office supplies','expense','debit',true)`, [expense, company]);
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});
afterAll(async () => { try { await purge(); } finally { await pool.end(); } }, 60_000);

describe('claimCapturedDocumentForPosting', () => {
  it("refuses a document being read as 'being_read' and stamps nothing", async () => {
    const id = await seed('reading');
    expect(await inTx(() => claimCapturedDocumentForPosting(company, id, null, { spend: 'invoice' }))).toBe('being_read');
    expect(await postedAt(id)).toBeNull();
  });

  it.each([['failed', 'failed', 1], ['gone silent', 'reading', 30]] as const)(
    "refuses a document whose read %s as 'not_read' and stamps nothing", async (_what, state, silent) => {
      const id = await seed(state, silent);
      expect(await inTx(() => claimCapturedDocumentForPosting(company, id, null, { spend: 'invoice' }))).toBe('not_read');
      expect(await postedAt(id)).toBeNull();
    });

  it('claims a document whose read finished', async () => {
    const id = await seed('done');
    expect(await inTx(() => claimCapturedDocumentForPosting(company, id, null, { spend: 'invoice' }))).toBeNull();
    expect(await postedAt(id)).not.toBeNull();
  });

  it("the UPDATE itself refuses a fresh 'reading' row even when nothing checked first", async () => {
    // Reaches the fence the way a caller that skips the pre-check would: the statement only.
    const id = await seed('reading');
    const rows = (await pool.query(
      `UPDATE captured_documents SET posted_at = NOW() WHERE id = $1 AND company_id = $2 AND posted_at IS NULL
         AND status <> 'rejected' AND read_state = 'done'
       RETURNING id`, [id, company])).rows;
    expect(rows).toHaveLength(0);
    const failed = await seed('failed');
    expect((await pool.query(
      `UPDATE captured_documents SET posted_at = NOW() WHERE id = $1 AND company_id = $2 AND posted_at IS NULL
         AND status <> 'rejected' AND read_state = 'done' RETURNING id`, [failed, company])).rows).toHaveLength(0);
  });
});

describe('claimLineSourceDocuments and the expense-claims route', () => {
  it("refuses a document being read as 'being_read', all or nothing", async () => {
    const reading = await seed('reading');
    const fine = await seed('done');
    const err = await inTx(() => claimLineSourceDocuments(company, [{ sourceDocumentId: fine }, { sourceDocumentId: reading }]))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaimSourceDocumentError);
    expect((err as ClaimSourceDocumentError).refusal).toBe('being_read');
    expect((err as ClaimSourceDocumentError).message).toBe(STILL_BEING_READ);
    expect(await postedAt(reading)).toBeNull();
    expect(await postedAt(fine)).toBeNull();
  });

  it.each([['failed', 'failed', 1], ['gone silent', 'reading', 30]] as const)(
    "refuses a document whose read %s as 'not_read', all or nothing", async (_what, state, silent) => {
      const bad = await seed(state, silent);
      const fine = await seed('done');
      const err = await inTx(() => claimLineSourceDocuments(company, [{ sourceDocumentId: fine }, { sourceDocumentId: bad }]))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ClaimSourceDocumentError);
      expect((err as ClaimSourceDocumentError).refusal).toBe('not_read');
      expect((err as ClaimSourceDocumentError).message).toBe(NOT_READ);
      expect(await postedAt(bad)).toBeNull();
      expect(await postedAt(fine)).toBeNull();
    });

  it('claims documents whose read finished', async () => {
    const a = await seed('done');
    const b = await seed('done');
    await inTx(() => claimLineSourceDocuments(company, [{ sourceDocumentId: a }, { sourceDocumentId: b }]));
    expect(await postedAt(a)).not.toBeNull();
    expect(await postedAt(b)).not.toBeNull();
  });

  it('POST /expense-claims answers 409 for a line on a document being read and creates no claim', async () => {
    const reading = await seed('reading');
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM expense_claims WHERE company_id=$1', [company])).rows[0].n;
    const out = await createClaim([line(reading)]);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(409);
    expect(out.body.error?.message).toBe(STILL_BEING_READ);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM expense_claims WHERE company_id=$1', [company])).rows[0].n).toBe(before);
    expect(await postedAt(reading)).toBeNull();
    const failed = await seed('failed');
    const out2 = await createClaim([line(failed)]);
    expect(out2.statusCode, JSON.stringify(out2.body)).toBe(409);
    expect(out2.body.error?.message).toBe(NOT_READ);
    expect(await postedAt(failed)).toBeNull();
    const ok = await createClaim([line(await seed('done'))]);
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(201);
  });
});
