import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import nlQuery from '../../pages/api/accounting/nl-query';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID();
const marker = `r004-disposable-secret-${crypto.randomUUID()}`;
let token = '', generatedSQL = '';
const originalFetch = globalThis.fetch;
beforeAll(async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'disposable-provider-fixture');
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'R004 function fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'manager')", [company, user]);
  await pool.query('INSERT INTO webhook_endpoints(company_id,name,url,secret) VALUES($1,$2,$3,$4)', [company, 'R004 fixture', 'http://127.0.0.1/unused', marker]);
  await pool.query('INSERT INTO customers(company_id,name) VALUES($1,$2),($1,$3)', [company, 'R004 customer A', 'R004 customer B']);
  token = await new SignJWT({ sub: user, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.href === 'https://api.anthropic.com/v1/messages') return new Response(JSON.stringify({ content: [{ text: JSON.stringify({ sql: generatedSQL, explanation: 'Disposable provider output' }) }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('External network forbidden in disposable NL fixture');
    return originalFetch(input, init);
  });
});
afterAll(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  try {
    await pool.query('DELETE FROM webhook_endpoints WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
    await pool.query('DELETE FROM rate_limit_counters WHERE key=ANY($1::text[])', [[`ai:nl-query:co:${company}`, `ai:nl-query:co:${company}:day`, 'ai:nl-query:ip:127.0.0.84']]);
  } finally { await pool.end(); }
});
async function ask(sql: string) {
  generatedSQL = sql; const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST');
  req.socket.remoteAddress = '127.0.0.84'; req.url = '/api/accounting/nl-query'; req.body = { question: 'Show requested financial records' };
  const result = response(); await nlQuery(req, result.res); return result;
}
it('blocks query_to_xml reading a non-allowlisted own-company relation', async () => {
  const result = await ask(`SELECT query_to_xml('SELECT secret FROM webhook_endpoints WHERE company_id = ''${company}''', true, false, '')`);
  expect(result.state.statusCode).toBe(200);
  expect(JSON.stringify(result.state.body)).not.toContain(marker);
  expect(result.state.body).toMatchObject({ data: { summary: 'Query rejected', rows: [] } });
});
it('blocks table_to_xml on a non-allowlisted relation', async () => {
  const result = await ask("SELECT table_to_xml('webhook_endpoints', true, false, '')");
  expect(JSON.stringify(result.state.body)).not.toContain(marker);
  expect(result.state.body).toMatchObject({ data: { summary: 'Query rejected', rows: [] } });
});
it('still executes an aggregate over an allowlisted own-company relation', async () => {
  const result = await ask(`SELECT count(*)::int AS customers FROM customers WHERE company_id = '${company}'`);
  expect(result.state.body).toMatchObject({ data: { rows: [{ customers: 2 }] } });
});
