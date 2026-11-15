// Tenant fence on the report joins keyed on bank_transactions.bank_account_id: cash-movement (opening and movement),
// the KPI dashboard's two cash queries, and the group dashboard's cash. Each seeds a line the unfenced query would count.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import cashMovement from '../../pages/api/accounting/reports/cash-movement';
import { getDashboardKPIs } from '@/modules/accounting/services/reports/kpiDashboardService';
import { getGroupDashboardStats } from '@/modules/accounting/services/reports/consolidatedReportingService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';
import { newSetupUser, type SetupUser } from './helpers/onboardingSetupFixture';
import { bankLine, dropCompanies, seedCompanies, uuid, type FenceCompanies } from './helpers/bankFenceFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const route = budgetsRouteFixture(pool, cashMovement, '/api/accounting/reports/cash-movement');
let u: SetupUser;
let c: FenceCompanies;
const group = uuid();

beforeAll(async () => {
  u = await newSetupUser(pool);
  c = await seedCompanies(pool, u.homeCompanyId);
  // A's own lines on A's bank: before the period (opening) and inside it.
  await bankLine(pool, c.a, c.bankA, '2025-03-10', 40);
  await bankLine(pool, c.a, c.bankA, '2025-04-10', 100);
  // B's lines pointing at A's GL account: the bt-side leak (cash-movement opening and movement).
  await bankLine(pool, c.b, c.bankA, '2025-03-12', 7000);
  await bankLine(pool, c.b, c.bankA, '2025-04-12', 5000);
  // A's lines pointing at B's GL account: the GL-side leak (KPI, group cash).
  await bankLine(pool, c.a, c.bankB, '2025-03-14', 50);
  await bankLine(pool, c.a, c.bankB, '2025-04-14', 300);
  await pool.query('INSERT INTO company_groups(id,name) VALUES($1,$2)', [group, 'Fence group']);
  await pool.query('INSERT INTO company_group_members(group_id,company_id) VALUES($1,$2),($1,$3)', [group, c.a, c.b]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM company_group_members WHERE group_id=$1', [group]);
    await pool.query('DELETE FROM company_groups WHERE id=$1', [group]);
    await dropCompanies(pool, c);
    await route.cleanup();
    await pool.query('DELETE FROM company_users WHERE user_id=$1', [u.userId]);
    await pool.query('DELETE FROM users WHERE id=$1', [u.userId]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [[c.a, c.b]]);
  } finally {
    await pool.end();
  }
}, 60000);

describe('bank tenant fence — reports', () => {
  it("cash-movement counts only this company's lines on its bank account (opening and movement)", async () => {
    const r = await route.call(u, 'GET', undefined, { from: '2025-04-01', to: '2025-04-30' });
    expect(r.status).toBe(200);
    const acc = (r.body.data as unknown as { accounts: Array<Record<string, number | string>> }).accounts
      .find((x) => x.account_id === c.bankA)!;
    expect(acc).toMatchObject({ opening_balance: 40, inflows: 100, outflows: 0 });
  });

  it("the KPI dashboard's cash counts no line on another company's GL account (current and prior)", async () => {
    const kpi = await getDashboardKPIs(c.a, '2025-04-01', '2025-04-30');
    expect(kpi.cash).toMatchObject({ total: 140, priorTotal: 40 });
  });

  it("the group dashboard's cash counts no line on another member's GL account", async () => {
    const stats = await getGroupDashboardStats(group);
    const cash = Object.fromEntries(stats.entitySummaries.map((e) => [e.companyId, e.cashPosition]));
    // A: 40 + 100 on its own bank; B: its 7000 + 5000 point at A's account, so none are B's cash.
    expect(cash[c.a]).toBe(140);
    expect(cash[c.b] ?? 0).toBe(0);
  });
});
