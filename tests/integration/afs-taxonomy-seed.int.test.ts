// tests/integration/afs-taxonomy-seed.int.test.ts
//
// A NEW company gets its AFS taxonomy from seedDefaultTaxonomy. If that seeder
// does not write `total_basis`, every top-level total on the new company's
// statements renders 0.00 — Total assets, Total equity and liabilities, and all
// four income statement bottom lines — because they carry no parent_code and
// the 'children' roll-up finds no siblings.
//
// Migration 533 repaired the companies that already existed. `seedDefaultTaxonomy`
// skips codes that are already present, so existing companies are never
// re-seeded and the migration cannot help a tenant created tomorrow. This test
// is what stops a new company being created broken.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { seedDefaultTaxonomy } from '@/modules/accounting/services/afs/afsMappingService';

const DATABASE_URL = process.env.DATABASE_URL;
const COMPANY = '00000000-0000-0000-0000-0000000000d1';

/** The six top-level totals and how each must be computed. */
const EXPECTED: Record<string, { basis: string; components: string[] | null }> = {
  BS038: { basis: 'components', components: ['BS021', 'BS037'] },
  BS082: { basis: 'components', components: ['BS048', 'BS057', 'BS073'] },
  IS452: { basis: 'running', components: null },
  IS471: { basis: 'running', components: null },
  IS480: { basis: 'running', components: null },
  IS485: { basis: 'running', components: null },
};

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('a newly seeded company can compute its statement totals', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test seeds and deletes an AFS taxonomy.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(admin);

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'Taxonomy Seed Fixture', true)
       ON CONFLICT (id) DO NOTHING`,
      [COMPANY],
    );

    await seedDefaultTaxonomy(COMPANY);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  it('seeds every top-level total with a basis that can actually compute it', async () => {
    const { rows } = await admin.query(
      `SELECT code, total_basis, total_components
         FROM afs_statement_lines
        WHERE company_id = $1 AND code = ANY($2)`,
      [COMPANY, Object.keys(EXPECTED)],
    );

    expect(rows).toHaveLength(Object.keys(EXPECTED).length);

    for (const row of rows) {
      const expected = EXPECTED[row.code as string]!;
      // 'children' here is the bug: these lines have no parent_code, so the
      // children roll-up finds nothing and the total renders 0.00.
      expect(`${row.code}:${row.total_basis}`).toBe(`${row.code}:${expected.basis}`);
      expect(row.total_components).toEqual(expected.components);
    }
  });

  it('every components total names lines that exist in the same taxonomy', async () => {
    // A component naming a code that was never seeded contributes nothing and
    // silently understates the total.
    const { rows } = await admin.query(
      `SELECT sl.code, c.component
         FROM afs_statement_lines sl
         CROSS JOIN LATERAL unnest(sl.total_components) AS c(component)
        WHERE sl.company_id = $1
          AND sl.total_basis = 'components'
          AND NOT EXISTS (
            SELECT 1 FROM afs_statement_lines t
             WHERE t.company_id = sl.company_id AND t.code = c.component
          )`,
      [COMPANY],
    );

    expect(rows).toEqual([]);
  });

  it('leaves the parented subtotals on the children basis', async () => {
    const { rows } = await admin.query(
      `SELECT code, total_basis FROM afs_statement_lines
        WHERE company_id = $1 AND code = ANY($2)`,
      [COMPANY, ['BS021', 'BS037', 'BS048', 'BS057', 'BS073']],
    );

    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.total_basis).toBe('children');
    }
  });
});

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM afs_statement_lines WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
}
