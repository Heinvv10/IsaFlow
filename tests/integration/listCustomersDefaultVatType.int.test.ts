// listCustomers returns each customer's default_vat_type: the New Quote modal types a line with none of its own from it
// (UI review M2), and the MCP list_customers tool passes it through. Runs in a transaction that is always rolled back.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { listCustomers } from '@/modules/accounting/services/core/contactDirectoryService';

const DATABASE_URL = process.env.DATABASE_URL;
const COMPANY = '00000000-0000-0000-0000-0000000d1c11';
const USER = '00000000-0000-0000-0000-0000000d1c12';

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('listCustomers returns default_vat_type', () => {
  let pool: Pool;

  beforeAll(() => {
    assertNotProductionDb('This test inserts customers (rolled back).');
    pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  });
  afterAll(async () => { await pool?.end(); });

  it('each row carries its customer\'s default VAT type (null when none is set)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, 'Quote VAT Default Co', true)`, [COMPANY]);
      await c.query('INSERT INTO customers (company_id, name, default_vat_type) VALUES ($1, $2, $3), ($1, $4, NULL)',
        [COMPANY, 'Exempt Trust', 'exempt', 'Plain Ltd']);
      const rows = await als.run({ client: c, userId: USER, companyId: COMPANY, claims: {} } as never, () => listCustomers(COMPANY));
      expect(rows.map((r) => [r.name, r.default_vat_type])).toEqual([['Exempt Trust', 'exempt'], ['Plain Ltd', null]]);
    } finally {
      // A failed ROLLBACK is thrown, never swallowed; the connection is released either way.
      try { await c.query('ROLLBACK'); } finally { c.release(); }
    }
  });
});
