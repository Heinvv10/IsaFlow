/**
 * Review follow-ups on GET /api/accounting/assets/afs-summary.
 *
 * MEDIUM 1 — the period guard was `/^\d{6}$/`, which accepts 202600 and 202613.
 *   Those used to flow through as opaque comparands; once the boundaries are
 *   derived by date arithmetic they throw, and withErrorHandler turns a
 *   caller's bad input into a 500. It is a 400.
 *
 * MEDIUM 2 — the prior-year snapshot takes each asset's LAST row at or before
 *   the prior year end. For an asset disposed before the year opened that row
 *   is the disposal row, which carries the full policy_cost. It landed in
 *   opening cost, and because the disposal fell outside the movement window
 *   disposalsCost never took it out again: the note footed arithmetically and
 *   was overstated by the cost of every asset ever disposed of.
 *
 * MEDIUM 3 — an asset with no ledger row at all is invisible to both queries.
 *   That is the documented consequence of building the note from the ledger;
 *   it is pinned here so a future change to either query has to face it.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import afsSummary from '../../pages/api/accounting/assets/afs-summary';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();   // financial_year_start = 3 -> FY2026 is Mar 25 - Feb 26
const user = crypto.randomUUID();
const category = crypto.randomUUID();
const liveAsset = crypto.randomUUID();
const disposedAsset = crypto.randomUUID();
const ledgerlessAsset = crypto.randomUUID();
let token = '';

const LIVE_COST = 10000;
const DISPOSED_COST = 40000;
const LEDGERLESS_COST = 7000;
const MONTHLY_DEP = 10;

async function ledgerRow(assetId: string, yyyymm: string, cost: number, opening: number, dep: number, proceeds: number | null = null) {
  const closing = opening + dep;
  await pool.query(
    `INSERT INTO asset_period_ledger(company_id,asset_id,period_date,yyyymm,policy_cost,
       policy_opening_acc_dep,policy_current_dep,policy_closing_acc_dep,policy_carrying_amount,
       tax_cost,tax_opening_acc_dep,tax_current_dep,tax_closing_acc_dep,tax_carrying_amount,
       disposal_proceeds)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$5,$6,$7,$8,$9,$10)`,
    [company, assetId, `${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}-28`, yyyymm,
     cost, opening, dep, closing, cost - closing, proceeds],
  );
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name,financial_year_start) VALUES($1,$2,3)', [company, 'K028 boundaries']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [company, user, 'admin']);
  await pool.query(
    `INSERT INTO asset_categories(id,name,code,sars_rate,sars_years,ias16_group)
     VALUES($1,'K028B Plant',$2,0.2,5,'PM')`,
    [category, `K028B-${category.slice(0, 8)}`],
  );
  const assets: [string, string, number][] = [
    [liveAsset, 'A-K028B-LIVE', LIVE_COST],
    [disposedAsset, 'A-K028B-GONE', DISPOSED_COST],
    [ledgerlessAsset, 'A-K028B-NOLEDGER', LEDGERLESS_COST],
  ];
  for (const [id, num, cost] of assets) {
    await pool.query(
      `INSERT INTO assets(id,company_id,asset_number,name,category_id,purchase_date,purchase_price,
         useful_life_years,status) VALUES($1,$2,$3,$3,$4,'2023-04-30',$5,5,'available')`,
      [id, company, num, category, cost],
    );
  }

  // Live asset: on the books from 202403 through the FY2026 year end.
  let opening = 0;
  for (const p of ['202403', '202412', '202502', '202503', '202509', '202602']) {
    await ledgerRow(liveAsset, p, LIVE_COST, opening, MONTHLY_DEP);
    opening += MONTHLY_DEP;
  }
  // Disposed asset: last row is the November 2024 disposal, well before FY2026 opens.
  await ledgerRow(disposedAsset, '202403', DISPOSED_COST, 0, MONTHLY_DEP);
  await ledgerRow(disposedAsset, '202411', DISPOSED_COST, MONTHLY_DEP, 0, 15000);
  // Ledger-less asset: rows in `assets` only.

  token = await new SignJWT({ sub: user, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM asset_period_ledger WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM assets WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM asset_categories WHERE id=$1', [category]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

interface Group {
  ias16Group: string;
  openingCost: number;
  additions: number;
  disposalsCost: number;
  closingCost: number;
}

function call(period: string) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'GET') as never as {
    url: string; query: Record<string, string>;
  };
  req.url = '/api/accounting/assets/afs-summary';
  req.query = { period };
  const result = response();
  return { req, result };
}

async function summary(period: string): Promise<Group[]> {
  const { req, result } = call(period);
  await afsSummary(req as never, result.res);
  expect(result.state.statusCode).toBe(200);
  return (result.state.body as { data: { groups: Group[] } }).data.groups;
}

it.each(['202600', '202613', '202699', '2026', 'abcdef'])(
  'rejects period %s as a 400, never a 500',
  async (period) => {
    const { req, result } = call(period);
    await afsSummary(req as never, result.res);
    expect(result.state.statusCode).toBe(400);
  },
);

it('accepts the month boundaries 01 and 12', async () => {
  for (const period of ['202601', '202612']) {
    const { req, result } = call(period);
    await afsSummary(req as never, result.res);
    expect(result.state.statusCode).toBe(200);
  }
});

it('leaves an asset disposed before the year out of opening cost', async () => {
  const [group] = await summary('202602');
  // The 40 000 asset went in November 2024, two financial years ago. Only the
  // live asset is on the books when FY2026 opens.
  expect(group!.openingCost).toBeCloseTo(LIVE_COST, 2);
  expect(group!.disposalsCost).toBeCloseTo(0, 2);
  expect(group!.additions).toBeCloseTo(0, 2);
  expect(group!.closingCost).toBeCloseTo(LIVE_COST, 2);
});

it('still reports a disposal that falls INSIDE the year', async () => {
  // FY2025 is Mar 24 - Feb 25, so the November 2024 disposal is in the window:
  // opening cost carries the asset, disposalsCost takes it out again.
  const [group] = await summary('202502');
  expect(group!.openingCost).toBeCloseTo(0, 2);
  expect(group!.additions).toBeCloseTo(LIVE_COST + DISPOSED_COST, 2);
  expect(group!.disposalsCost).toBeCloseTo(DISPOSED_COST, 2);
  expect(group!.closingCost).toBeCloseTo(LIVE_COST, 2);
});

it('omits an asset that has no ledger row at all', async () => {
  const [group] = await summary('202602');
  // Documented limit: the note is built from asset_period_ledger, so an asset
  // that has never been through a depreciation run contributes nothing.
  expect(group!.closingCost).toBeCloseTo(LIVE_COST, 2);
  expect(group!.closingCost).not.toBeCloseTo(LIVE_COST + LEDGERLESS_COST, 2);
});
