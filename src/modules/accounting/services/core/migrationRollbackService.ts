/**
 * Migration rollback — remove the GL accounts one import created.
 *
 * Extracted from migrationExecuteService so that file stays under the 300-line
 * cap; executeMigration re-exports both symbols, so callers are unchanged.
 *
 * The whole design question here is what to do about the OTHER rows. Deleting
 * an account is refused by any of the dozens of foreign keys pointing at
 * `gl_accounts`, nearly all of them NO ACTION, and a single DELETE over the
 * whole set means one blocking row aborts the entire rollback. Enumerating the
 * blockers in SQL would go stale the first time a table is added; letting
 * Postgres refuse the row cannot. So a refusal retains one account, and the
 * caller is told which.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { MigrationSource } from './migrationParserService';
import type { DbRow } from '@/types/db';

/**
 * Accounts the rollback could not remove because other rows still point at
 * them are RETAINED, not deleted — and the caller is told which, so the UI
 * never reports a partial rollback as a clean one.
 */
export interface RollbackResult {
  deleted: number;
  retained: number;
  retainedCodes: string[];
}

/** Postgres foreign_key_violation: something still points at the account. */
const FK_VIOLATION = '23503';

function isFkViolation(err: unknown): boolean {
  return (err as { code?: string }).code === FK_VIOLATION;
}

export async function rollbackMigration(
  companyId: string,
  source: MigrationSource,
): Promise<RollbackResult> {
  const retained: { id: string; code: string }[] = [];
  let deleted = 0;

  try {
    const candidates = (await sql`
      SELECT id, account_code FROM gl_accounts
      WHERE company_id = ${companyId}::UUID AND imported_from = ${source}
      ORDER BY account_code
    `) as DbRow[];

    // Fast path. Nothing blocking is the normal case for an import rolled back
    // before it was used, and the loop below costs three round trips per
    // account inside the request transaction — 1,200 of them on a 400-account
    // chart. One 23503 here rolls its own savepoint back and nothing else, so
    // the loop is paid for only when it is actually needed.
    const bulk = candidates.length === 0 ? [] : await withSavepoint('mig_rb_bulk', async () => (await sql`
      DELETE FROM gl_accounts
      WHERE company_id = ${companyId}::UUID AND imported_from = ${source}
      RETURNING id
    `) as DbRow[]).catch((err: unknown) => {
      if (!isFkViolation(err)) throw err;
      return null;
    });

    if (bulk) {
      // Not `bulk.length === candidates.length` assumed: a statement that
      // succeeds can still touch fewer rows than the SELECT saw — a concurrent
      // delete, or a row hidden by an RLS USING clause — and those survivors
      // keep an armed tag. Whatever did not come back is retained, and is
      // untagged by the shared tail below exactly as the loop's are.
      const removed = new Set(bulk.map(r => String(r.id)));
      deleted = bulk.length;
      for (const row of candidates) {
        if (removed.has(String(row.id))) continue;
        retained.push({ id: String(row.id), code: String(row.account_code) });
      }
    } else {
      for (const [i, row] of candidates.entries()) {
        const id = String(row.id);
        const code = String(row.account_code);
        try {
          // RETURNING, not the absence of a throw: a candidate the SELECT saw
          // can be gone by now, or invisible to an RLS USING clause, and
          // neither is a deletion this rollback performed.
          const gone = await withSavepoint(`mig_rb_${i}`, async () => (await sql`
            DELETE FROM gl_accounts
            WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
            RETURNING id
          `) as DbRow[]);
          if (gone.length > 0) { deleted += 1; } else { retained.push({ id, code }); }
        } catch (err) {
          // A deadlock or a lock timeout is not a retention decision — rethrow.
          if (!isFkViolation(err)) throw err;
          retained.push({ id, code });
        }
      }
    }

    // A retained account keeps nothing of the import. Leaving the tag on would
    // leave the delete armed: once the blocking rows go, a later rollback of
    // the same source would take an account that has been in normal use since.
    if (retained.length > 0) {
      await sql`
        UPDATE gl_accounts SET imported_from = NULL
        WHERE company_id = ${companyId}::UUID AND id = ANY(${retained.map(r => r.id)}::UUID[])
      `;
    }

    log.info('Rollback complete', { companyId, source, deleted, retained: retained.length }, 'migration');
  } catch (err) {
    log.error('Rollback failed', { companyId, source, error: err }, 'migration');
    throw err;
  }

  return { deleted, retained: retained.length, retainedCodes: retained.map(r => r.code) };
}
