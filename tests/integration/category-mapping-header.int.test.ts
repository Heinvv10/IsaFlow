/**
 * saveCategoryMapping (migration 905's company_category_mappings) refuses a header account: one any account
 * names as its parent, active or not. A pool suggestion must name an account a bank line can post to.
 * A posting account of the same company still saves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asUser, pool, seedCompany, seedUser, teardownCompanies, type Co } from './learning-loop.helpers';
import { CategoryMappingRefusal, saveCategoryMapping } from '../../src/modules/accounting/services/sharedPool/categoryMappingService';

assertDisposable();

let co: Co;
let member = '';
const child = crypto.randomUUID();

beforeAll(async () => {
  co = await seedCompany('905 header mapping co');
  member = await seedUser([co.id]);
  // 6100 Fuel becomes a header: an INACTIVE child still makes it one.
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, parent_account_id, is_active)
     VALUES ($1, $2, '6110', 'Fuel - old', 'expense', 'debit', $3, false)`, [child, co.id, co.expense]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM company_category_mappings WHERE company_id = $1', [co.id]);
    await pool.query('DELETE FROM gl_accounts WHERE id = $1', [child]);
    await teardownCompanies([co.id], [member]);
  } finally {
    await pool.end();
  }
});

describe('saveCategoryMapping', () => {
  it('refuses a header account and writes nothing', async () => {
    const rows = await asUser(member, co.id, async (c) => {
      await expect(saveCategoryMapping(co.id, member, 'fuel', co.expense)).rejects.toBeInstanceOf(CategoryMappingRefusal);
      return (await c.query('SELECT 1 FROM company_category_mappings WHERE company_id = $1', [co.id])).rows;
    });
    expect(rows).toEqual([]);
  });

  it('saves a posting account', async () => {
    const rows = await asUser(member, co.id, async (c) => {
      await saveCategoryMapping(co.id, member, 'telephone', co.other);
      return (await c.query('SELECT category_code, gl_account_id FROM company_category_mappings WHERE company_id = $1', [co.id])).rows;
    });
    expect(rows).toEqual([{ category_code: 'telephone', gl_account_id: co.other }]);
  });
});
