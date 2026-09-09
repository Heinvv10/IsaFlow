/**
 * K-026 RED. POST /api/accounting/assets/below-threshold
 * (git show ebeac9ca:pages/api/accounting/assets/below-threshold.ts, lines 44-69)
 *
 *  - is wrapped `withAuth(withCsrf(withErrorHandler(handler)))` — NO
 *    `withWriteAccess`, so a company `viewer` can post a GL journal;
 *  - takes no row lock and asks no "already expensed?" question before calling
 *    `postCapitalizationExpenseToGL`, which posts an unconditional
 *    debit expense / credit bank journal (glCrossModuleHooks.ts:271-287).
 *    `below_threshold = true` is written afterwards and never read back as a guard.
 *
 * So two ordinary sequential requests expense the same asset twice.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import belowThreshold from '../../pages/api/accounting/assets/below-threshold';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const viewer = crypto.randomUUID();
const asset = crypto.randomUUID();
const category = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const otherAsset = crypto.randomUUID();
const raceAsset = crypto.randomUUID();
const disposedAsset = crypto.randomUUID();
const writtenOffAsset = crypto.randomUUID();
const closedPeriodAsset = crypto.randomUUID();
const lockAsset = crypto.randomUUID();
let adminToken = '', viewerToken = '';

async function account(code: string, name: string, type: string, subtype: string, normal: string) {
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,
       normal_balance,is_active,is_system_account) VALUES($1,$2,$3,$4,$5,$6,true,true)`,
    [company, code, name, type, subtype, normal],
  );
}

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K026 asset fixture')", [company]);
  for (const [id, role] of [[admin, 'admin'], [viewer, 'viewer']] as const) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,$3,true)", [id, `${id}@test.local`, role]);
    await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [company, id, role]);
  }
  const y = new Date().getUTCFullYear();
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K026 FY',1,$2,$3,$4,'open')`,
    [company, y, `${y}-01-01`, `${y}-12-31`],
  );
  await account('6000', 'K026 Expense', 'expense', 'default_expense', 'debit');
  await account('1000', 'K026 Bank', 'asset', 'bank', 'debit');
  clearSystemAccountCache(company);

  // asset_categories is a global reference table (no company_id) shared with
  // other agents on this fixture DB — name AND code are unique, so both carry the
  // run's own suffix; a run killed before afterAll must not block the next one.
  await pool.query(
    `INSERT INTO asset_categories(id,name,code,sars_rate,sars_years,capitalization_threshold)
     VALUES($1,$2,$3,0.33,3,5000)`,
    [category, `K026 Small tools ${category.slice(0, 8)}`, `K026-${category.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO assets(id,company_id,asset_number,name,category_id,purchase_date,purchase_price,
       useful_life_years,status) VALUES($1,$2,'A-K026','K026 Drill',$3,'2026-01-15',1200,3,'available')`,
    [asset, company, category],
  );

  const addAsset = (id: string, number: string, price: number, status = 'available') => pool.query(
    `INSERT INTO assets(id,company_id,asset_number,name,category_id,purchase_date,purchase_price,
       useful_life_years,status) VALUES($1,$2,$3,$3,$4,'2026-01-15',$5,3,$6)`,
    [id, company, number, category, price, status],
  );
  await addAsset(raceAsset, 'A-K026-R', 700);
  await addAsset(disposedAsset, 'A-K026-D', 800, 'disposed');
  await addAsset(writtenOffAsset, 'A-K026-W', 850, 'written_off');
  await addAsset(closedPeriodAsset, 'A-K026-C', 950);
  await addAsset(lockAsset, 'A-K026-L', 650);

  // Second tenant: same category, its own asset. Nothing this route does may reach it.
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K026 other tenant')", [otherCompany]);
  await pool.query(
    `INSERT INTO assets(id,company_id,asset_number,name,category_id,purchase_date,purchase_price,
       useful_life_years,status) VALUES($1,$2,'A-K026-B','K026 Other drill',$3,'2026-01-15',900,3,'available')`,
    [otherAsset, otherCompany, category],
  );

  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  adminToken = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(secret);
  viewerToken = await new SignJWT({ sub: viewer, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(secret);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM assets WHERE company_id=ANY($1::uuid[])', [[company, otherCompany]]);
    await pool.query('DELETE FROM asset_categories WHERE id=$1', [category]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [[company, otherCompany]]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [[admin, viewer]]);
  } finally { await pool.end(); }
});

async function expenseAs(token: string, targetAsset: string = asset) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as {
    url: string; body: unknown; query: Record<string, string>;
  };
  req.url = '/api/accounting/assets/below-threshold';
  req.query = {};
  req.body = { assetId: targetAsset };
  const result = response();
  await belowThreshold(req as never, result.res);
  return result;
}

async function expenseJournalCount(): Promise<number> {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='auto_asset_expense'",
    [company],
  );
  return rows[0].n as number;
}

async function journalsFor(assetNumber: string): Promise<number> {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND description LIKE $2",
    [company, `%${assetNumber}%`],
  );
  return rows[0].n as number;
}

async function flagOf(id: string): Promise<unknown> {
  const { rows } = await pool.query('SELECT below_threshold FROM assets WHERE id=$1', [id]);
  return rows[0]?.below_threshold;
}

it('expensing the same below-threshold asset twice posts ONE journal', async () => {
  const first = await expenseAs(adminToken);
  expect(first.state.statusCode).toBe(200);
  expect(await expenseJournalCount()).toBe(1);

  const second = await expenseAs(adminToken);
  // Refuse the repeat as a state conflict — and never post a second journal.
  expect(second.state.statusCode).toBe(409);
  expect(await expenseJournalCount()).toBe(1);
});

it('the expense account is debited once, not twice', async () => {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(jl.debit),0)::float8 AS debited
       FROM gl_journal_lines jl JOIN gl_accounts a ON a.id = jl.gl_account_id
      WHERE jl.company_id=$1 AND a.account_code='6000'`,
    [company],
  );
  expect(rows[0].debited).toBeCloseTo(1200, 2);
});

it('a viewer cannot expense an asset to the general ledger', async () => {
  const before = await expenseJournalCount();
  const result = await expenseAs(viewerToken);
  // The route is wrapped withAuth(withCsrf(withErrorHandler(handler))) — no
  // withWriteAccess — so a read-only member posts to the ledger.
  expect(result.state.statusCode).toBe(403);
  expect(await expenseJournalCount()).toBe(before);
});

it('the posted journal balances and equals the asset cost', async () => {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(jl.debit),0)::float8 AS debit, COALESCE(SUM(jl.credit),0)::float8 AS credit
       FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id=$1 AND je.source='auto_asset_expense'`,
    [company],
  );
  expect(rows[0].debit).toBeCloseTo(1200, 2);
  expect(rows[0].credit).toBeCloseTo(1200, 2);
});

it("another company's asset is not expensable through this company's session", async () => {
  const result = await expenseAs(adminToken, otherAsset);
  expect(result.state.statusCode).toBe(404);

  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1",
    [otherCompany],
  );
  expect(rows[0].n).toBe(0);
  const { rows: flag } = await pool.query('SELECT below_threshold FROM assets WHERE id=$1', [otherAsset]);
  expect(flag[0].below_threshold).not.toBe(true);
});

it('a malformed request posts nothing', async () => {
  const before = await expenseJournalCount();
  const req = request({ 'sb-access-token': adminToken, active_company_id: company }, 'POST') as never as {
    url: string; body: unknown; query: Record<string, string>;
  };
  req.url = '/api/accounting/assets/below-threshold';
  req.query = {};
  req.body = {};
  const result = response();
  await belowThreshold(req as never, result.res);
  expect(result.state.statusCode).toBe(400);
  expect(await expenseJournalCount()).toBe(before);
});

it('two concurrent requests for the same asset post ONE journal', async () => {
  const [a, b] = await Promise.all([expenseAs(adminToken, raceAsset), expenseAs(adminToken, raceAsset)]);
  const codes = [a.state.statusCode, b.state.statusCode].sort();
  expect(codes).toEqual([200, 409]);

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n, COALESCE(SUM(jl.debit),0)::float8 AS debit
       FROM gl_journal_entries je
       JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.debit > 0
      WHERE je.company_id=$1 AND je.description LIKE '%A-K026-R%'`,
    [company],
  );
  expect(rows[0].n).toBe(1);
  expect(rows[0].debit).toBeCloseTo(700, 2);
});

it('a disposed asset cannot be expensed', async () => {
  const result = await expenseAs(adminToken, disposedAsset);
  expect(result.state.statusCode).toBe(400);
  expect(await journalsFor('A-K026-D')).toBe(0);
  expect(await flagOf(disposedAsset)).not.toBe(true);
});

it('a written-off asset cannot be expensed', async () => {
  const result = await expenseAs(adminToken, writtenOffAsset);
  expect(result.state.statusCode).toBe(400);
  expect(await journalsFor('A-K026-W')).toBe(0);
});

it('a closed fiscal period is a 400, not a 500, and leaves no draft journal', async () => {
  await pool.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1", [company]);
  try {
    const result = await expenseAs(adminToken, closedPeriodAsset);
    expect(result.state.statusCode).toBe(400);
    // The hook creates the DRAFT journal before postJournalEntry would throw, and
    // withAuth COMMITs on a 4xx — so a post-hoc catch would leave an orphan draft.
    expect(await journalsFor('A-K026-C')).toBe(0);
    expect(await flagOf(closedPeriodAsset)).not.toBe(true);
  } finally {
    await pool.query("UPDATE fiscal_periods SET status='open' WHERE company_id=$1", [company]);
  }
});

it('a request that cannot get the row lock is refused, not queued forever', async () => {
  const holder = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const held = await holder.connect();
    await held.query('BEGIN');
    await held.query('SELECT id FROM assets WHERE id=$1 FOR UPDATE', [lockAsset]);

    const result = await expenseAs(adminToken, lockAsset);
    expect(result.state.statusCode).toBe(409);
    expect(await journalsFor('A-K026-L')).toBe(0);

    await held.query('ROLLBACK');
    held.release();
  } finally {
    await holder.end();
  }
}, 20000);

it('GET reports which assets have already been expensed', async () => {
  const req = request({ 'sb-access-token': adminToken, active_company_id: company }, 'GET') as never as {
    url: string; query: Record<string, string>;
  };
  req.url = '/api/accounting/assets/below-threshold';
  req.query = {};
  const result = response();
  await belowThreshold(req as never, result.res);
  expect(result.state.statusCode).toBe(200);

  const rows = (result.state.body as { data: Array<{ id: string; expensed: boolean }> }).data;
  expect(rows.find(r => r.id === asset)?.expensed).toBe(true);
  expect(rows.find(r => r.id === lockAsset)?.expensed).toBe(false);
});
