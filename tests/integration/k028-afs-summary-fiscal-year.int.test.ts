/**
 * R-007 (same handler as K-028). GET /api/accounting/assets/afs-summary
 *
 * The period boundaries used to be hardcoded to a December year end:
 *   priorYYYYMM      = `${year - 1}${month}`   // same month, a year earlier
 *   currentYearStart = `${year}01`             // January, for everyone
 *
 * For a February year end (financial_year_start = 3) that puts the movement
 * window in the wrong twelve months entirely: at an interim period the prior
 * snapshot lands mid-year, and at the year end only the January-to-period
 * stub is picked up, so the depreciation charge and the additions test both
 * read the wrong span. Boundaries now come from the company's own basis.
 *
 * Adjacent cases: a second company's figures must not move, and an interim
 * period must still snapshot the prior FINANCIAL year end.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import afsSummary from '../../pages/api/accounting/assets/afs-summary';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const febCompany = crypto.randomUUID();   // financial_year_start = 3 → Feb year end
const otherCompany = crypto.randomUUID(); // untouched neighbour, also March-start
const user = crypto.randomUUID();
const category = crypto.randomUUID();
const oldAsset = crypto.randomUUID();
const newAsset = crypto.randomUUID();
const otherAsset = crypto.randomUUID();
let token = '';

const OLD_COST = 80000;    // owned since 2023 — opening cost of FY2026 (Mar 25 - Feb 26)
const NEW_COST = 30000;    // bought September 2025 — inside FY2026, a genuine addition
const OTHER_COST = 12000;  // belongs to the neighbouring tenant
const MONTHLY_DEP_OLD = 100;
const MONTHLY_DEP_NEW = 50;

/** Periods from `from` to `to` inclusive, as YYYYMM. */
function periods(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(4, 6));
  for (;;) {
    const p = `${y}${String(m).padStart(2, '0')}`;
    out.push(p);
    if (p === to) return out;
    if (m === 12) { y += 1; m = 1; } else { m += 1; }
  }
}

async function ledgerRow(companyId: string, assetId: string, yyyymm: string, cost: number, opening: number, dep: number) {
  const closing = opening + dep;
  await pool.query(
    `INSERT INTO asset_period_ledger(company_id,asset_id,period_date,yyyymm,policy_cost,
       policy_opening_acc_dep,policy_current_dep,policy_closing_acc_dep,policy_carrying_amount,
       tax_cost,tax_opening_acc_dep,tax_current_dep,tax_closing_acc_dep,tax_carrying_amount)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$5,$6,$7,$8,$9)`,
    [companyId, assetId, `${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}-28`, yyyymm,
     cost, opening, dep, closing, cost - closing],
  );
}

/** Writes a run of periods with a flat monthly charge, returning the closing acc dep. */
async function ledgerRun(companyId: string, assetId: string, from: string, to: string, cost: number, openingAccDep: number, dep: number) {
  let opening = openingAccDep;
  for (const p of periods(from, to)) {
    await ledgerRow(companyId, assetId, p, cost, opening, dep);
    opening += dep;
  }
  return opening;
}

beforeAll(async () => {
  for (const [id, name] of [[febCompany, 'R007 Feb year end'], [otherCompany, 'R007 neighbour']] as const) {
    await pool.query('INSERT INTO companies(id,name,financial_year_start) VALUES($1,$2,3)', [id, name]);
  }
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  for (const c of [febCompany, otherCompany]) {
    await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [c, user, 'admin']);
  }
  await pool.query(
    `INSERT INTO asset_categories(id,name,code,sars_rate,sars_years,ias16_group)
     VALUES($1,'R007 Plant',$2,0.2,5,'PM')`,
    [category, `R007-${category.slice(0, 8)}`],
  );
  const assets: [string, string, string, number][] = [
    [oldAsset, febCompany, 'A-R007-OLD', OLD_COST],
    [newAsset, febCompany, 'A-R007-NEW', NEW_COST],
    [otherAsset, otherCompany, 'A-R007-OTHER', OTHER_COST],
  ];
  for (const [id, companyId, num, cost] of assets) {
    await pool.query(
      `INSERT INTO assets(id,company_id,asset_number,name,category_id,purchase_date,purchase_price,
         useful_life_years,status) VALUES($1,$2,$3,$3,$4,'2023-04-30',$5,5,'available')`,
      [id, companyId, num, category, cost],
    );
  }

  // OLD: owned through FY2025 (ends 202502), then all twelve months of FY2026.
  await ledgerRun(febCompany, oldAsset, '202303', '202502', OLD_COST, 0, MONTHLY_DEP_OLD);
  await ledgerRun(febCompany, oldAsset, '202503', '202602', OLD_COST, 24 * MONTHLY_DEP_OLD, MONTHLY_DEP_OLD);
  // NEW: first ledger period September 2025 — inside FY2026.
  await ledgerRun(febCompany, newAsset, '202509', '202602', NEW_COST, 0, MONTHLY_DEP_NEW);
  // Neighbour: same shape, different tenant.
  await ledgerRun(otherCompany, otherAsset, '202303', '202602', OTHER_COST, 0, MONTHLY_DEP_NEW);

  token = await new SignJWT({ sub: user, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    for (const c of [febCompany, otherCompany]) {
      await pool.query('DELETE FROM asset_period_ledger WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM assets WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM company_users WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM companies WHERE id=$1', [c]);
    }
    await pool.query('DELETE FROM asset_categories WHERE id=$1', [category]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

interface Group {
  ias16Group: string;
  openingCost: number;
  additions: number;
  closingCost: number;
  depreciationCharge: number;
}

async function summary(companyId: string, period: string): Promise<Group[]> {
  const req = request({ 'sb-access-token': token, active_company_id: companyId }, 'GET') as never as {
    url: string; query: Record<string, string>;
  };
  req.url = '/api/accounting/assets/afs-summary';
  req.query = { period };
  const result = response();
  await afsSummary(req as never, result.res);
  expect(result.state.statusCode).toBe(200);
  return (result.state.body as { data: { groups: Group[] } }).data.groups;
}

it('snapshots a February year end at February, and charges twelve months', async () => {
  const [group] = await summary(febCompany, '202602');
  expect(group!.ias16Group).toBe('PM');
  // Opening cost is the 202502 snapshot: the old asset only.
  expect(group!.openingCost).toBeCloseTo(OLD_COST, 2);
  expect(group!.additions).toBeCloseTo(NEW_COST, 2);
  expect(group!.closingCost).toBeCloseTo(OLD_COST + NEW_COST, 2);
  // Mar 2025 - Feb 2026: 12 months on the old asset, 6 (Sep-Feb) on the new one.
  expect(group!.depreciationCharge).toBeCloseTo(12 * MONTHLY_DEP_OLD + 6 * MONTHLY_DEP_NEW, 2);
});

it('an interim period still opens at the prior FINANCIAL year end', async () => {
  const [group] = await summary(febCompany, '202509');
  expect(group!.openingCost).toBeCloseTo(OLD_COST, 2);
  expect(group!.additions).toBeCloseTo(NEW_COST, 2);
  // Mar-Sep 2025 is 7 months on the old asset; the new asset's first period is Sep.
  expect(group!.depreciationCharge).toBeCloseTo(7 * MONTHLY_DEP_OLD + 1 * MONTHLY_DEP_NEW, 2);
});

it('leaves the neighbouring tenant untouched', async () => {
  const [group] = await summary(otherCompany, '202602');
  expect(group!.openingCost).toBeCloseTo(OTHER_COST, 2);
  expect(group!.additions).toBeCloseTo(0, 2);
  expect(group!.closingCost).toBeCloseTo(OTHER_COST, 2);
});

it('refuses a company with no financial year basis rather than assuming one', async () => {
  await pool.query('UPDATE companies SET financial_year_start = NULL WHERE id = $1', [febCompany]);
  try {
    const req = request({ 'sb-access-token': token, active_company_id: febCompany }, 'GET') as never as {
      url: string; query: Record<string, string>;
    };
    req.url = '/api/accounting/assets/afs-summary';
    req.query = { period: '202602' };
    const result = response();
    // withErrorHandler turns the refusal into a 500 — a loud stop, not a guessed note.
    await afsSummary(req as never, result.res);
    expect(result.state.statusCode).toBe(500);
  } finally {
    await pool.query('UPDATE companies SET financial_year_start = 3 WHERE id = $1', [febCompany]);
  }
});
