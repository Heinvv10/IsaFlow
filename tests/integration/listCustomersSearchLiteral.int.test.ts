// listCustomers' search text is bound into ILIKE. A literal % or _ in it must match literally, not as a
// wildcard. Runs in a transaction that is always rolled back, so nothing is left behind.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { listCustomers } from '@/modules/accounting/services/core/contactDirectoryService';

const DATABASE_URL = process.env.DATABASE_URL;
const COMPANY = '00000000-0000-0000-0000-0000000d1c01';
const USER = '00000000-0000-0000-0000-0000000d1c02';

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('listCustomers search matches %, _ and \\ literally', () => {
  let pool: Pool;

  beforeAll(() => {
    assertNotProductionDb('This test inserts customers (rolled back).');
    pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  });
  afterAll(async () => { await pool?.end(); });

  async function namesFor(names: string[], search: string): Promise<string[]> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, 'D1 Search Co', true)`, [COMPANY]);
      for (const name of names) await c.query('INSERT INTO customers (company_id, name) VALUES ($1, $2)', [COMPANY, name]);
      const rows = await als.run({ client: c, userId: USER, companyId: COMPANY, claims: {} } as never, () => listCustomers(COMPANY, search));
      return rows.map((r) => String(r.name)).sort();
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }

  it('a % in the search matches only a name containing %', async () => {
    expect(await namesFor(['50% Off Traders', '50 Percent Traders', 'Acme'], '50%')).toEqual(['50% Off Traders']);
  });

  it('a _ in the search matches only a name containing _', async () => {
    expect(await namesFor(['A_B Ltd', 'AxB Ltd'], 'A_B')).toEqual(['A_B Ltd']);
  });

  it('a backslash in the search matches only a name containing a backslash', async () => {
    expect(await namesFor(['Back\\slash Co', 'Backslash Co'], 'k\\s')).toEqual(['Back\\slash Co']);
  });

  it('an ordinary term still matches as contains, case-insensitively', async () => {
    expect(await namesFor(['Acme Trading', 'Beta'], 'acme')).toEqual(['Acme Trading']);
  });
});
