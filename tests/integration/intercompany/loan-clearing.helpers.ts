/**
 * The dark flag `intercompany_loan_clearing` (migration 1028) for the intercompany suites. With it off for a company, that company sends no
 * allocation message (the payer's hook) and cannot accept one (the receiver's clearing). The flag tables are read-only to app roles since
 * migration 945, so the fixture plants the override as the pool's own role (the table owner / migration role), never as app_user.
 *
 * The P1 fixture (`intercompany.fixture.ts` setup) turns it ON for A, B and C, so every suite that expects a send or an accept runs as before;
 * a case that needs it off says so with `setLoanClearing(pool, [co.X], false)` (or `null`: no override, the default) and puts it back.
 */
import type { Pool } from 'pg';

export const LOAN_CLEARING = 'intercompany_loan_clearing';
/** Who planted the override (company_feature_overrides.set_by is NOT NULL; a fixture is no platform admin). */
const FIXTURE_ADMIN = '00000000-0000-4000-8000-00000000f1a9';

/** The override of each company: `true` / `false` planted (upsert), `null` removed (the company falls back to the flag's default: off). */
export async function setLoanClearing(pool: Pool, companies: readonly string[], enabled: boolean | null): Promise<void> {
  if (enabled === null) {
    await pool.query(
      `DELETE FROM company_feature_overrides WHERE company_id = ANY($1::uuid[])
          AND feature_id = (SELECT id FROM feature_flags WHERE code = $2)`, [companies, LOAN_CLEARING]);
    return;
  }
  const { rowCount } = await pool.query(
    `INSERT INTO company_feature_overrides(company_id, feature_id, enabled, reason, set_by)
     SELECT c, ff.id, $3, 'intercompany integration fixture', $4::uuid FROM feature_flags ff, unnest($1::uuid[]) c WHERE ff.code = $2
     ON CONFLICT (company_id, feature_id) DO UPDATE SET enabled = EXCLUDED.enabled`, [companies, LOAN_CLEARING, enabled, FIXTURE_ADMIN]);
  // a database without the flag row would leave every suite silently flag-off: say so instead
  if (rowCount !== companies.length) throw new Error(`the ${LOAN_CLEARING} flag is not seeded (migration 1028): ${rowCount} of ${companies.length} overrides written`);
}

/** Every override these companies carry (the fixture's cleanup, before the companies go: the table has no ON DELETE). */
export async function dropFeatureOverrides(pool: Pool, companies: readonly string[]): Promise<void> {
  await pool.query('DELETE FROM company_feature_overrides WHERE company_id = ANY($1::uuid[])', [companies]);
}
