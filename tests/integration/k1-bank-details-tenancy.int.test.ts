/**
 * Wave 3 K1, tenancy of payroll_bank_details: RLS as app_user (a member of both companies, working in one), the route
 * across companies, the service's own predicate where RLS does not stand in for it (app_service's USING (true) mirror,
 * 915), and /api/payroll/duplicates masking.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import duplicates from '../../pages/api/payroll/duplicates';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { asApp, cleanupEntityChanges, members, newCompany, outcome } from './entity-changes.helpers';
import { asService, employee, get, OTHER, put, ROW, rowsOf } from './k1-employee-bank-details.helpers';
import {
  getEmployeeBankDetails, parseBankDetailsInput, setEmployeeBankDetails,
} from '../../src/modules/accounting/services/payroll/payrollBankDetailsService';
import type { DuplicateResult } from '../../src/modules/accounting/services/payroll/payrollDuplicateDetectionService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let both = '', onlyB = '', m = '', viewer = '';
let A = '', B = '', empA = '', empB = '';

beforeAll(async () => {
  [both, onlyB, m, viewer] = await members(pool, tokens, 4);
  A = await newCompany(pool, [[both, 'owner'], [m, 'manager'], [viewer, 'viewer']], companies);
  B = await newCompany(pool, [[both, 'owner'], [onlyB, 'owner']], companies);
  empA = await employee(pool, A);
  empB = await employee(pool, B);
  expect((await put(tokens[both]!, A, empA, ROW)).state.statusCode).toBe(200);
  expect((await put(tokens[both]!, B, empB, OTHER)).state.statusCode).toBe(200);
});
afterAll(() => cleanupEntityChanges(pool, companies, [both, onlyB, m, viewer]));

describe('RLS', () => {
  it('a member of both companies, working in B, cannot read or update A\'s row', async () => {
    const seen = await asApp(pool, both, B, async (db) => (await db.query('SELECT employee_id FROM payroll_bank_details')).rows);
    expect(seen.map((r) => r.employee_id)).toEqual([empB]);
    const updated = await asApp(pool, both, B, async (db) => (await db.query(
      'UPDATE payroll_bank_details SET bank_name = $2 WHERE employee_id = $1', [empA, 'Hijack'])).rowCount);
    expect(updated).toBe(0);
  });

  it('a user outside A, claiming A as the active company, reads nothing', async () => {
    const seen = await asApp(pool, onlyB, A, async (db) => (await db.query('SELECT 1 FROM payroll_bank_details')).rowCount);
    expect(seen).toBe(0);
  });

  it('a viewer of the company reads nothing (the role is in the policy, not only the route)', async () => {
    const seen = await asApp(pool, viewer, A, async (db) => (await db.query('SELECT 1 FROM payroll_bank_details')).rowCount);
    expect(seen).toBe(0);
  });

  const insert = (company: string, emp: string) => (db: { query: Pool['query'] }) => db.query(
    `INSERT INTO payroll_bank_details (company_id, employee_id, bank_name, account_number, branch_code, is_active)
     VALUES ($1, $2, 'Forged', '999999999', '250655', false)`, [company, emp]);

  it('refuses a row filed under another company', async () => {
    expect(await outcome(asApp(pool, both, B, insert(A, empA)))).toMatch(/^42501/);
  });

  it('refuses a row in the active company pointing at another company\'s employee', async () => {
    expect(await outcome(asApp(pool, both, B, insert(B, empA)))).toMatch(/^42501/);
  });

  it('refuses an update that moves a row to another company\'s employee', async () => {
    expect(await outcome(asApp(pool, both, B, (db) => db.query(
      'UPDATE payroll_bank_details SET employee_id = $2 WHERE employee_id = $1', [empB, empA])))).toMatch(/^42501/);
  });
});

describe('the route across companies', () => {
  it('B\'s owner gets a 404 for A\'s employee, reading and writing, and A\'s rows do not move', async () => {
    const before = await rowsOf(pool, empA);
    expect((await get(tokens[onlyB]!, B, empA)).state.statusCode).toBe(404);
    expect((await put(tokens[onlyB]!, B, empA, OTHER)).state.statusCode).toBe(404);
    expect(await rowsOf(pool, empA)).toEqual(before);
  });
});

describe('the service\'s own company predicate (no RLS behind it on the service pool)', () => {
  it('reads nothing of A\'s employee for company B', async () => {
    expect(await asService(pool, B, () => getEmployeeBankDetails(B, empA, 'owner'))).toBeNull();
    expect(await asService(pool, A, () => getEmployeeBankDetails(A, empA, 'owner'))).not.toBeNull();
  });

  it('refuses a write for company B to A\'s employee, as not found', async () => {
    const input = parseBankDetailsInput(OTHER);
    await expect(asService(pool, B, () => setEmployeeBankDetails(B, empA, input, 'owner'))).rejects.toMatchObject({ status: 404 });
  });
});

describe('/api/payroll/duplicates', () => {
  let c = '';
  const same = '11112229333';
  const twin = '44445559333'; // the same last four as `same`: two groups a masked list must still keep apart

  beforeAll(async () => {
    c = await newCompany(pool, [[both, 'owner'], [m, 'manager']], companies);
    for (const account of [same, same, twin, twin]) {
      const res = await put(tokens[both]!, c, await employee(pool, c), { ...ROW, accountNumber: account });
      expect(res.state.statusCode).toBe(200);
    }
  });
  const read = (user: string) => callRoute(duplicates, tokens[user]!, c, 'GET', undefined, '/api/payroll/duplicates');

  it('a manager sees the last four only; grouping still used the whole number', async () => {
    const res = await read(m);
    const { bankAccount } = dataOf<DuplicateResult>(res);
    expect(bankAccount.map((g) => [g.value, g.employees.length])).toEqual([['…9333', 2], ['…9333', 2]]);
    expect(JSON.stringify(res.state.body)).not.toContain(same);
    expect(JSON.stringify(res.state.body)).not.toContain(twin);
  });

  it('an owner sees the whole number', async () => {
    const { bankAccount } = dataOf<DuplicateResult>(await read(both));
    expect(bankAccount.map((g) => g.value)).toEqual([same, twin]);
  });
});
