/**
 * K-028 RED. GET /api/accounting/assets/afs-summary
 * (git show ebeac9ca:pages/api/accounting/assets/afs-summary.ts)
 *
 * The additions test at line 55
 *     CASE WHEN MIN(apl.yyyymm) >= ${currentYearStart} THEN MAX(apl.policy_cost) ELSE 0 END
 * is evaluated over a set the WHERE clause at line 64 has ALREADY restricted to
 * `apl.yyyymm >= ${currentYearStart}`. MIN over that set is therefore always
 * >= currentYearStart, so every asset with any ledger row in the year reports
 * its full cost as an addition — including one bought years earlier, which the
 * prior-year snapshot query (lines 34-47) has already counted as opening cost.
 *
 * aggregatePpeMovements then computes closingCost = openingCost + additions
 * (farAfsService.ts:140), so the AFS note 3 closing cost double-counts every
 * pre-existing asset and cannot foot to the ledger.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import afsSummary from '../../pages/api/accounting/assets/afs-summary';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const oldAsset = crypto.randomUUID();
const newAsset = crypto.randomUUID();
const category = crypto.randomUUID();
let token = '';

const OLD_COST = 100000;   // bought 2024, already on the books at 2025-12-31
const NEW_COST = 50000;    // bought June 2026 — the only genuine addition
const OLD_OPENING_ACC_DEP = 10000;
const MONTHLY_DEP_OLD = 1000;  // 12 months of 2026
const MONTHLY_DEP_NEW = 500;   // 7 periods, Jun..Dec 2026

async function ledgerRow(assetId: string, yyyymm: string, cost: number, opening: number, dep: number) {
  const closing = opening + dep;
  await pool.query(
    `INSERT INTO asset_period_ledger(company_id,asset_id,period_date,yyyymm,policy_cost,
       policy_opening_acc_dep,policy_current_dep,policy_closing_acc_dep,policy_carrying_amount,
       tax_cost,tax_opening_acc_dep,tax_current_dep,tax_closing_acc_dep,tax_carrying_amount)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$5,$6,$7,$8,$9)`,
    [company, assetId, `${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}-28`, yyyymm,
     cost, opening, dep, closing, cost - closing],
  );
}

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K028 AFS fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [company, user, 'admin']);
  await pool.query(
    `INSERT INTO asset_categories(id,name,code,sars_rate,sars_years,ias16_group)
     VALUES($1,'K028 Plant',$2,0.2,5,'PM')`,
    [category, `K028-${category.slice(0, 8)}`],
  );
  for (const [id, num, cost] of [[oldAsset, 'A-K028-OLD', OLD_COST], [newAsset, 'A-K028-NEW', NEW_COST]] as const) {
    await pool.query(
      `INSERT INTO assets(id,company_id,asset_number,name,category_id,purchase_date,purchase_price,
         useful_life_years,status) VALUES($1,$2,$3,$3,$4,'2024-06-30',$5,5,'available')`,
      [id, company, num, category, cost],
    );
  }

  // OLD: closed 2025 at 10 000 accumulated depreciation, then 12 periods of 2026.
  await ledgerRow(oldAsset, '202512', OLD_COST, OLD_OPENING_ACC_DEP - MONTHLY_DEP_OLD, MONTHLY_DEP_OLD);
  for (let m = 1; m <= 12; m++) {
    const opening = OLD_OPENING_ACC_DEP + (m - 1) * MONTHLY_DEP_OLD;
    await ledgerRow(oldAsset, `2026${String(m).padStart(2, '0')}`, OLD_COST, opening, MONTHLY_DEP_OLD);
  }
  // NEW: first ledger period is June 2026.
  for (let m = 6; m <= 12; m++) {
    const opening = (m - 6) * MONTHLY_DEP_NEW;
    await ledgerRow(newAsset, `2026${String(m).padStart(2, '0')}`, NEW_COST, opening, MONTHLY_DEP_NEW);
  }

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

interface Group { ias16Group: string; openingCost: number; additions: number; closingCost: number }

async function summary(period: string): Promise<Group[]> {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'GET') as never as {
    url: string; query: Record<string, string>;
  };
  req.url = '/api/accounting/assets/afs-summary';
  req.query = { period };
  const result = response();
  await afsSummary(req as never, result.res);
  expect(result.state.statusCode).toBe(200);
  const body = result.state.body as { data: { groups: Group[] } };
  return body.data.groups;
}

it('reports only the current-year purchase as an addition', async () => {
  const [group] = await summary('202612');
  expect(group!.ias16Group).toBe('PM');
  expect(group!.openingCost).toBeCloseTo(OLD_COST, 2);
  // Only the June 2026 asset is an addition. The 2024 asset already sits in opening cost.
  expect(group!.additions).toBeCloseTo(NEW_COST, 2);
});

it('closing cost foots to opening plus genuine additions', async () => {
  const [group] = await summary('202612');
  expect(group!.closingCost).toBeCloseTo(OLD_COST + NEW_COST, 2);
});
