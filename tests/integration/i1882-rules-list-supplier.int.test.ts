/**
 * #1882: the bank rules list (getRules, the rules page's Supplier / Customer column) names a rule's supplier even when it was
 * merged away or deleted, and says which: "Name (merged into Survivor)" or "Name (deleted)", company-scoped. It showed "—" for both
 * (and for a live supplier with no company_name). Real PostgreSQL as app_user. Fixture route: isaflow_schema_fixture. Never skips.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture } from './helpers/budgetBillFixture';
import { seedSupplier } from './helpers/poBillLinkHarness';
import { getRules } from '@/modules/accounting/services/bank/bankRulesService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
afterAll(async () => { await pool.end(); });

describe('the rules list names a rule\'s supplier and what became of it', () => {
  it('live, merged into its survivor, deleted', async () => {
    const fx = await seedBillFixture(pool, 'i1882-rules-list');
    try {
      const survivor = await seedSupplier(pool, fx, 'Kite Holdings');
      const merged = await seedSupplier(pool, fx, 'Kite Metals');
      const deleted = await seedSupplier(pool, fx, 'Gone Couriers');
      await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [merged, survivor]);
      await pool.query('UPDATE suppliers SET deleted_at = now() WHERE id = $1', [deleted]);
      await pool.query(`INSERT INTO bank_categorisation_rules (company_id, rule_name, match_field, match_type, match_pattern, supplier_id, priority)
                        VALUES ($1, 'r1 live', 'description', 'contains', 'A', $2, 1), ($1, 'r2 merged', 'description', 'contains', 'B', $3, 2),
                               ($1, 'r3 deleted', 'description', 'contains', 'C', $4, 3)`, [fx.co, survivor, merged, deleted]);
      const r = await openRequest(pool, fx, fx.owner);
      try {
        const rules = await r.run(() => getRules(fx.co));
        expect(rules.map((x) => [x.ruleName, x.supplierName])).toEqual([
          ['r1 live', 'Kite Holdings'],
          ['r2 merged', 'Kite Metals (merged into Kite Holdings)'],
          ['r3 deleted', 'Gone Couriers (deleted)'],
        ]);
      } finally { await r.rollback(); }
    } finally {
      await pool.query('DELETE FROM bank_categorisation_rules WHERE company_id = $1', [fx.co]);
      await dropBillFixture(pool, fx);
    }
  }, 30_000);
});
