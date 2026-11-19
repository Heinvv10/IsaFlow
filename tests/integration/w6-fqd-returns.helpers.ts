/**
 * Teardown for FQd suites that finalise returns through the lifecycle: the company's tax_return_versions (history, kept
 * by an immutability trigger, lifted for these rows only in one transaction, as returnVersionsFixture's drop does), then
 * the sars_submissions they name. The shared rig cleanup knows neither.
 */
import type { Pool } from 'pg';

export async function dropReturnRows(pool: Pool, companyId: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE tax_return_versions DISABLE TRIGGER trg_tax_return_versions_immutable');
    await c.query('DELETE FROM tax_return_versions WHERE company_id = $1', [companyId]);
    await c.query('ALTER TABLE tax_return_versions ENABLE ALWAYS TRIGGER trg_tax_return_versions_immutable');
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
  await pool.query('DELETE FROM sars_submissions WHERE company_id = $1', [companyId]);
}
