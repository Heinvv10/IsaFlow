/**
 * Wave 3 K1, tenancy of payroll_bank_details: RLS as app_user (a member of both companies, working in one), who may
 * update what, the route across companies, the service's own predicate where RLS does not stand in for it (a role that
 * bypasses it), the service pool and the platform admin having no reach, and /api/payroll/duplicates masking.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import duplicates from '../../pages/api/payroll/duplicates';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { dataOf, impersonationToken } from './r035-pr2.helpers';
import { as, asApp, cleanupEntityChanges, members, newCompany, outcome } from './entity-changes.helpers';
import { employee, get, OTHER, outsideRls, put, ROW, rowsOf } from './k1-employee-bank-details.helpers';
import {
  employeeExists, getEmployeeBankDetails, parseBankDetailsInput, setEmployeeBankDetails,
} from '../../src/modules/accounting/services/payroll/payrollBankDetailsService';
import { findDuplicates, type DuplicateResult } from '../../src/modules/accounting/services/payroll/payrollDuplicateDetectionService';

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
afterAll(async () => {
  await pool.query('DELETE FROM impersonation_sessions WHERE target_user_id = $1', [both]);
  await cleanupEntityChanges(pool, companies, [both, onlyB, m, viewer]);
});

describe('RLS', () => {
  it('a member of both companies, working in B, cannot read or update A\'s row', async () => {
    const seen = await asApp(pool, both, B, async (db) => (await db.query('SELECT employee_id FROM payroll_bank_details')).rows);
    expect(seen.map((r) => r.employee_id)).toEqual([empB]);
    const updated = await asApp(pool, both, B, async (db) => (await db.query(
      'UPDATE payroll_bank_details SET is_active = false WHERE employee_id = $1', [empA])).rowCount);
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

describe('who may update a stored row', () => {
  const entered = async () => {
    const e = await employee(pool, A);
    expect((await put(tokens[both]!, A, e, ROW)).state.statusCode).toBe(200);
    return e;
  };
  const rewrite = (e: string) => (db: { query: Pool['query'] }) => db.query(
    "UPDATE payroll_bank_details SET account_number = '999999999' WHERE employee_id = $1", [e]);
  const retire = (e: string) => (db: { query: Pool['query'] }) => db.query(
    'UPDATE payroll_bank_details SET is_active = false WHERE employee_id = $1', [e]);

  it('a manager\'s direct UPDATE of the account number is refused', async () => {
    const e = await entered();
    expect(await outcome(asApp(pool, m, A, rewrite(e)))).toMatch(/^42501/);
    expect((await rowsOf(pool, e))[0]).toMatchObject({ account_number: ROW.accountNumber, is_active: true });
  });

  it('nor may an owner rewrite one: a change is a new row, so the number on file cannot be replaced unseen', async () => {
    const e = await entered();
    expect(await outcome(asApp(pool, both, A, rewrite(e)))).toMatch(/^42501/);
    expect((await rowsOf(pool, e))[0]).toMatchObject({ account_number: ROW.accountNumber });
  });

  it('a manager cannot retire a row either: the policy passes over it', async () => {
    const e = await entered();
    expect((await asApp(pool, m, A, retire(e))).rowCount).toBe(0);
    expect((await rowsOf(pool, e))[0]).toMatchObject({ is_active: true });
  });

  it('an owner can retire one', async () => {
    const e = await entered();
    expect((await asApp(pool, both, A, retire(e))).rowCount).toBe(1);
    expect((await rowsOf(pool, e))[0]).toMatchObject({ is_active: false });
  });
});

describe('the service pool and the platform admin', () => {
  const asRole = <T>(role: string, fn: Parameters<typeof as<T>>[3]) => as(pool, both, { role, claims: null }, fn);
  const retire = (db: { query: Pool['query'] }) => db.query('UPDATE payroll_bank_details SET is_active = false WHERE employee_id = $1', [empA]);

  it('app_service, with no claims: reads nothing, writes nothing', async () => {
    expect(await asRole('app_service', async (db) => (await db.query('SELECT 1 FROM payroll_bank_details')).rowCount)).toBe(0);
    expect((await asRole('app_service', retire)).rowCount).toBe(0);
    expect(await outcome(asRole('app_service', (db) => db.query(
      `INSERT INTO payroll_bank_details (company_id, employee_id, bank_name, account_number, branch_code, is_active)
       VALUES ($1, $2, 'Forged', '999999999', '250655', false)`, [A, empA])))).toMatch(/^42501/);
  });

  it('platform_admin has no privilege on the table at all', async () => {
    expect(await outcome(asRole('platform_admin', (db) => db.query('SELECT 1 FROM payroll_bank_details')))).toMatch(/^42501/);
    expect(await outcome(asRole('platform_admin', retire))).toMatch(/^42501/);
  });
});

// What 952's header and the payroll .claude.md say stays open. A fix turns these red: then correct both.
describe('stated residual risks', () => {
  it('entity_changes keeps its app_service mirror: the service pool reads the whole number there, with no claims', async () => {
    const seen = await as(pool, both, { role: 'app_service', claims: null }, async (db) => (await db.query(
      `SELECT "after"->>'account_number' AS n FROM entity_changes WHERE entity_type = 'payroll_bank_detail' AND company_id = $1`, [A])).rows);
    expect(seen.map((r) => r.n)).toContain(ROW.accountNumber);
  });

  it('duplicates can confirm a manager\'s guess: a first entry with the guessed number joins its group', async () => {
    const c = await newCompany(pool, [[both, 'owner'], [m, 'manager']], companies);
    expect((await put(tokens[both]!, c, await employee(pool, c), ROW)).state.statusCode).toBe(200);
    expect((await put(tokens[m]!, c, await employee(pool, c), ROW)).state.statusCode).toBe(200);
    const res = await callRoute(duplicates, tokens[m]!, c, 'GET', undefined, '/api/payroll/duplicates');
    expect(dataOf<DuplicateResult>(res).bankAccount.map((g) => g.employees.length)).toEqual([2]);
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

describe('the service\'s own company predicate (with no RLS behind it)', () => {
  it('reads nothing of A\'s employee for company B', async () => {
    expect(await outsideRls(pool, B, () => getEmployeeBankDetails(B, empA, 'owner'))).toBeNull();
    expect(await outsideRls(pool, A, () => getEmployeeBankDetails(A, empA, 'owner'))).not.toBeNull();
  });

  it('refuses a write for company B to A\'s employee, as not found', async () => {
    const input = parseBankDetailsInput(OTHER);
    await expect(outsideRls(pool, B, () => setEmployeeBankDetails(B, empA, input, 'owner'))).rejects.toMatchObject({ status: 404 });
  });

  it('the existence check answers for its own company only', async () => {
    expect(await outsideRls(pool, B, () => employeeExists(B, empA))).toBe(false);
    expect(await outsideRls(pool, A, () => employeeExists(A, empA))).toBe(true);
  });

  it('duplicates count only a row filed under this company, whatever employee it points at', async () => {
    const number = '77778889111';
    const c = await newCompany(pool, [[both, 'owner']], companies);
    const [one, two] = [await employee(pool, c), await employee(pool, c)];
    const row = (company: string, emp: string) => pool.query(
      `INSERT INTO payroll_bank_details (company_id, employee_id, bank_name, account_number, branch_code)
       VALUES ($1, $2, 'Planted', $3, '250655')`, [company, emp, number]);
    await row(c, one);
    await row(B, two);
    expect((await outsideRls(pool, c, () => findDuplicates(c, { fullBankAccounts: true }))).bankAccount).toEqual([]);
    expect((await outsideRls(pool, B, () => findDuplicates(B, { fullBankAccounts: true }))).bankAccount).toEqual([]);
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
  const readAs = (token: string) => callRoute(duplicates, token, c, 'GET', undefined, '/api/payroll/duplicates');
  const read = (user: string) => readAs(tokens[user]!);

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

  // Security review of K1: the owner's role is not enough, the session must be the owner's own.
  it.each([
    ['Login-as of the owner', () => impersonationToken(pool, both, m)],
    ['a token channel (claims without a session id)', () => new SignJWT({ sub: both, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET))],
  ])('%s still gets a masked list', async (_name, token) => {
    const res = await readAs(await token());
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(dataOf<DuplicateResult>(res).bankAccount.map((g) => g.value)).toEqual(['…9333', '…9333']);
    expect(JSON.stringify(res.state.body)).not.toContain(same);
  });
});
