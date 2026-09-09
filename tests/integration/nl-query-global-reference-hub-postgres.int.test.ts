import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import nlQuery from '../../pages/api/accounting/nl-query';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const own = crypto.randomUUID(), foreign = crypto.randomUUID(), user = crypto.randomUUID(), category = crypto.randomUUID();
const FOREIGN_ASSET = `r009-foreign-asset-${crypto.randomUUID()}`;
let token = '', generatedSQL = '';
const originalFetch = globalThis.fetch;
beforeAll(async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'disposable-provider-fixture');
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [own, 'R009 own', foreign, 'R009 foreign']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'manager')", [own, user]);
  await pool.query("INSERT INTO asset_categories(id,name,code,depreciation_method,sars_rate,sars_years) VALUES($1,'R009 shared',$2,'straight_line',20,5)", [category, `R009-${category.slice(0, 8)}`]);
  await pool.query("INSERT INTO assets(company_id,asset_number,name,category_id,purchase_date,purchase_price,useful_life_years,depreciation_method,status) VALUES($1,'R009-OWN','R009 own asset',$3,'2026-01-01',1000,5,'straight_line','available'),($2,'R009-FOR',$4,$3,'2026-01-01',1000,5,'straight_line','available')", [own, foreign, category, FOREIGN_ASSET]);
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
    await pool.query('DELETE FROM assets WHERE company_id=ANY($1::uuid[])', [[own, foreign]]);
    await pool.query('DELETE FROM asset_categories WHERE id=$1', [category]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [own]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [[own, foreign]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
    await pool.query('DELETE FROM rate_limit_counters WHERE key=ANY($1::text[])', [[`ai:nl-query:co:${own}`, `ai:nl-query:co:${own}:day`, 'ai:nl-query:ip:127.0.0.85']]);
  } finally { await pool.end(); }
});
async function ask(sql: string) {
  generatedSQL = sql; const req = request({ 'sb-access-token': token, active_company_id: own }, 'POST');
  req.socket.remoteAddress = '127.0.0.85'; req.url = '/api/accounting/nl-query'; req.body = { question: 'Show requested financial records' };
  const result = response(); await nlQuery(req, result.res); return result;
}
it('blocks a join back through the global asset_categories table into another tenant', async () => {
  const result = await ask(`SELECT a2.company_id, a2.name FROM assets a1 JOIN asset_categories ac ON a1.category_id = ac.id JOIN assets a2 ON a2.category_id = ac.id WHERE a1.company_id = '${own}'`);
  expect(result.state.statusCode).toBe(200);
  expect(JSON.stringify(result.state.body)).not.toContain(FOREIGN_ASSET);
  expect(result.state.body).toMatchObject({ data: { summary: 'Scope error', rows: [] } });
});
it('still returns own assets with their category name', async () => {
  const result = await ask(`SELECT a.name, ac.name AS category FROM assets a JOIN asset_categories ac ON a.category_id = ac.id WHERE a.company_id = '${own}'`);
  expect(result.state.body).toMatchObject({ data: { rows: [{ name: 'R009 own asset', category: 'R009 shared' }] } });
});
