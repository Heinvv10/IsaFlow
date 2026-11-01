/**
 * pdfShared's settings fallback: another company's letterhead must never reach
 * a PDF. No RLS outside a request, so this tests the query's own predicate.
 * Disposable schema fixture only; synthetic data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getCompanyDetailsFromCompany } from '../../src/modules/accounting/services/core/pdfShared';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { newSetupUser, type SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const ghost = crypto.randomUUID();
let user: SetupUser;

const setName = (company: string, name: string) => pool.query(
  `INSERT INTO accounting_settings(company_id,key,value) VALUES($1,'company_name',$2)`, [company, name]);

beforeAll(async () => {
  user = await newSetupUser(pool);
  await setName(user.homeCompanyId, 'OTHER TENANT Letterhead');
  await setName(ghost, 'The Right Letterhead');
}, 60_000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM accounting_settings WHERE company_id = ANY($1::uuid[])', [[user.homeCompanyId, ghost]]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [user.homeCompanyId]);
    await pool.query('DELETE FROM companies WHERE id=$1', [user.homeCompanyId]);
    await pool.query('DELETE FROM users WHERE id=$1', [user.userId]);
  } finally {
    await pool.end();
  }
});

describe('getCompanyDetailsFromCompany, on a company with no companies row', () => {
  it('reads its own settings', async () => {
    expect((await getCompanyDetailsFromCompany(ghost)).name).toBe('The Right Letterhead');
  });

  it('falls back to the neutral name, never another company\'s, when it has none', async () => {
    expect((await getCompanyDetailsFromCompany(crypto.randomUUID())).name).toBe('Company Name Not Set');
  });
});
