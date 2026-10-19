/**
 * The Sage account-mapping calls selected `sage_accounts.sage_account_id` and `sage_accounts.name`, which that
 * table does not have (it has sage_id and account_name), so listing the mappings, auto-mapping and mapping an
 * account by hand all threw 42703. The row shapes the UI reads (sageAccountId, sageName) are unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { getAccountMappings, autoMapAccounts, mapAccount } from '../../src/modules/accounting/services/core/sageMigrationService';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = crypto.randomUUID();
const company = crypto.randomUUID();
const bank = crypto.randomUUID();
const sales = crypto.randomUUID();

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `g01sage-${user}@test.local`]);
  await pool.query('INSERT INTO companies(id,name,financial_year_start) VALUES($1,$2,1)', [company, 'G01 sage columns']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
     VALUES($1,$3,'1000','Bank account','asset','debit',3,true),($2,$3,'4000','Sales revenue','revenue','credit',3,true)`,
    [bank, sales, company]);
  await pool.query(
    `INSERT INTO sage_accounts(id,company_id,sage_id,account_code,account_name,account_type,balance,mapping_status)
     VALUES(gen_random_uuid(),$1,'SG-1','1000','Bank account','5',100,'unmapped'),
           (gen_random_uuid(),$1,'SG-2','4000','Odd name entirely','1',200,'unmapped')`, [company]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_migration_runs WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM sage_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('the Sage account-mapping calls run against the real columns', () => {
  it('lists the mappings with the field names the UI reads', async () => {
    const list = await getAccountMappings(company);
    expect(list.map((m) => [m.sageAccountId, m.sageName, m.sageBalance, m.mappingStatus]))
      .toEqual([['SG-1', 'Bank account', 100, 'unmapped'], ['SG-2', 'Odd name entirely', 200, 'unmapped']]);
  });

  it('auto-maps an exact name match and leaves the other unmapped', async () => {
    await autoMapAccounts(company, user);
    const byId = Object.fromEntries((await getAccountMappings(company)).map((m) => [m.sageAccountId, m]));
    expect(byId['SG-1']).toMatchObject({ glAccountCode: '1000', mappingStatus: 'auto' });
    expect(byId['SG-2']).toMatchObject({ glAccountCode: null, mappingStatus: 'unmapped' });
  });

  it('maps by hand, and unmaps, by the Sage id; an unknown id is refused', async () => {
    await mapAccount(company, 'SG-2', sales, 'by hand');
    expect((await getAccountMappings(company)).find((m) => m.sageAccountId === 'SG-2')).toMatchObject({ glAccountCode: '4000', mappingStatus: 'manual' });
    await mapAccount(company, 'SG-2', null);
    expect((await getAccountMappings(company)).find((m) => m.sageAccountId === 'SG-2')).toMatchObject({ glAccountCode: null, mappingStatus: 'unmapped' });
    await expect(mapAccount(company, 'SG-nope', sales)).rejects.toThrow(/Sage account not found/);
  });
});

describe('auto-mapping fails closed on a Sage account type it cannot resolve', () => {
  it('leaves a text-typed and an untyped account unmapped, with the reason on the account', async () => {
    // Both are named exactly like the revenue GL account. Their types do not resolve (the map is numeric), so the
    // type filter used to be skipped and they were mapped across types.
    await pool.query(
      `INSERT INTO sage_accounts(id,company_id,sage_id,account_code,account_name,account_type,balance,mapping_status)
       VALUES(gen_random_uuid(),$1,'SG-T','9001','Sales revenue','Asset',10,'unmapped'),
             (gen_random_uuid(),$1,'SG-N','9002','Sales revenue',NULL,20,'unmapped'),
             (gen_random_uuid(),$1,'SG-U','9003','Sales revenue','99',30,'unmapped')`, [company]);
    const run = await autoMapAccounts(company, user);
    const byId = Object.fromEntries((await getAccountMappings(company)).map((m) => [m.sageAccountId, m]));
    for (const id of ['SG-T', 'SG-N', 'SG-U']) {
      expect(byId[id]).toMatchObject({ glAccountId: null, mappingStatus: 'unmapped' });
      expect(byId[id]!.mappingNotes).toMatch(/^Not auto-mapped: /);
    }
    expect(byId['SG-T']!.mappingNotes).toContain("'Asset'");
    expect(byId['SG-N']!.mappingNotes).toContain('has no type');
    expect(run.skipped).toBeGreaterThanOrEqual(3);
  });

  it('still maps an account whose numeric type resolves, even when it arrives as text', async () => {
    await pool.query(
      `INSERT INTO sage_accounts(id,company_id,sage_id,account_code,account_name,account_type,balance,mapping_status)
       VALUES(gen_random_uuid(),$1,'SG-R','9004','Sales revenue','1',40,'unmapped')`, [company]);
    await autoMapAccounts(company, user);
    expect((await getAccountMappings(company)).find((m) => m.sageAccountId === 'SG-R')).toMatchObject({ glAccountCode: '4000', mappingStatus: 'auto' });
  });
});
