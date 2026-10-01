// W1-02 (PUR-08): GET /api/accounting/document-capture?id= through the real
// withAuth chain on the disposable fixture DB. A captured document belongs to
// one company: its owner reads it, anyone else gets a 404 — not the row.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import route from '../../pages/api/accounting/document-capture';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const companyA = crypto.randomUUID();
const companyB = crypto.randomUUID();
const userA = crypto.randomUUID();
const userB = crypto.randomUUID();
// Member of BOTH companies: RLS lets A's row through to this user, so only the
// handler's own `company_id = active company` predicate can refuse it.
const userAB = crypto.randomUUID();
const doc = crypto.randomUUID();
const tokens: Record<string, string> = {};

async function mint(sub: string): Promise<string> {
  return new SignJWT({ sub, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

function get(user: string, company: string, id: string) {
  const req = request({ 'sb-access-token': tokens[user]!, active_company_id: company }, 'GET');
  req.url = `/api/accounting/document-capture?id=${id}`;
  req.query = { id };
  const result = response();
  return route(req, result.res).then(() => result);
}

async function purge(): Promise<void> {
  await pool.query('DELETE FROM captured_documents WHERE id=$1', [doc]);
  await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[])', [[companyA, companyB]]);
  await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [[companyA, companyB]]);
  await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [[userA, userB, userAB]]);
}

beforeAll(async () => {
  await purge();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$3),($2,$4)', [companyA, companyB, 'W102 A', 'W102 B']);
  for (const [u, c] of [[userA, companyA], [userB, companyB]] as const) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [u, `${u}@test.local`]);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [c, u]);
    tokens[u] = await mint(u);
  }
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [userAB, `${userAB}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$3,'admin'),($2,$3,'admin')", [companyA, companyB, userAB]);
  tokens[userAB] = await mint(userAB);
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,vendor_name,status)
     VALUES($1,$2,'w102.pdf','pdf','receipt','Shell Garage','pending')`,
    [doc, companyA],
  );
});

afterAll(async () => {
  try { await purge(); } finally { await pool.end(); }
}, 60_000);

describe('W1-02 document-capture ?id= tenant scope', () => {
  it('returns the row to the company that owns it', async () => {
    const r = await get(userA, companyA, doc);
    expect(r.state.statusCode).toBe(200);
    expect((r.state.body as { data: { id: string; vendorName: string } }).data)
      .toMatchObject({ id: doc, vendorName: 'Shell Garage' });
  });

  it("404s the same id for another company's user", async () => {
    const r = await get(userB, companyB, doc);
    expect(r.state.statusCode).toBe(404);
    expect(JSON.stringify(r.state.body)).not.toContain('Shell Garage');
  });

  it("404s another company's id even for a user who is a member of both (RLS cannot help)", async () => {
    const r = await get(userAB, companyB, doc);
    expect(r.state.statusCode).toBe(404);
    expect(JSON.stringify(r.state.body)).not.toContain('Shell Garage');
  });
});
