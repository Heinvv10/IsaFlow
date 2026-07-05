/**
 * Data correction: flip legacy status='reversed' originals back to 'posted'.
 *
 * Before the reversal-semantics fix, reverseJournalEntry marked the ORIGINAL
 * entry status='reversed' AND posted a contra. Every report and the
 * gl_account_balances cache filter status='posted', so the reversed original was
 * dropped while the contra stayed — driving affected accounts to the NEGATIVE of
 * the original instead of zero.
 *
 * The fix keeps the original status='posted' (reversal becomes metadata:
 * reversed_at / reversal_of_id). This script heals HISTORICAL pairs created
 * under the old behaviour: it finds status='reversed' originals that HAVE a
 * posted contra (linked via gl_journal_entries.reversal_of_id) and flips them
 * back to 'posted', so original + contra once again net to zero. The
 * reversed_at / reversed_by metadata is preserved, so the pair still reads as
 * "reversed" everywhere that now keys on reversed_at.
 *
 * The reversed->posted UPDATE crosses the 'posted' boundary, so the migration-499
 * trigger fires and rebuilds gl_account_balances for the affected accounts from
 * posted lines (now including the original) — self-healing the cache.
 *
 * Reversed originals WITHOUT a posted contra are REPORTED SEPARATELY and NEVER
 * touched — those are not a simple reversal pair and need manual review.
 *
 * SAFE BY DEFAULT: dry-run unless --apply is passed. Idempotent — a repaired
 * original is status='posted' and no longer matches.
 *
 * Usage (operator, against prod):
 *   bunx tsx scripts/fixes/repair-reversed-journal-status.ts               # dry-run
 *   bunx tsx scripts/fixes/repair-reversed-journal-status.ts --apply       # apply
 *   bunx tsx scripts/fixes/repair-reversed-journal-status.ts --apply --company <uuid>
 *
 * Prefer MIGRATION_ADMIN_DATABASE_URL (a BYPASSRLS role) so no rows are hidden;
 * falls back to DATABASE_URL.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Env loading — must run before the @/lib/neon pool is first used.
// ---------------------------------------------------------------------------
const envPath = path.resolve(__dirname, '..', '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, rawV] = m;
    if (!process.env[k!]) process.env[k!] = rawV!.replace(/^["']|["']$/g, '');
  }
}

if (process.env.MIGRATION_ADMIN_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.MIGRATION_ADMIN_DATABASE_URL;
} else if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL (or MIGRATION_ADMIN_DATABASE_URL) is not set. Create .env.local or export it.');
  process.exit(1);
}

import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const apply = args.includes('--apply');
const companyFilter = getArg('--company');

if (companyFilter && !UUID_PATTERN.test(companyFilter)) {
  console.error(`--company must be a UUID, got: ${companyFilter}`);
  process.exit(1);
}

console.log(
  `\nRepair reversed-original journal status — mode=${apply ? 'APPLY (mutating)' : 'DRY-RUN'}` +
    `${companyFilter ? ` company=${companyFilter}` : ' (all companies)'}\n`,
);

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** status='reversed' originals that HAVE a posted contra (repairable). */
async function findRepairable(): Promise<Row[]> {
  if (companyFilter) {
    return (await sql`
      SELECT orig.id AS orig_id, orig.company_id, orig.entry_number,
             contra.id AS contra_id, contra.entry_number AS contra_number
      FROM gl_journal_entries orig
      JOIN gl_journal_entries contra
        ON contra.reversal_of_id = orig.id
       AND contra.company_id = orig.company_id
       AND contra.status = 'posted'
      WHERE orig.status = 'reversed'
        AND orig.company_id = ${companyFilter}::UUID
      ORDER BY orig.company_id, orig.entry_number
    `) as Row[];
  }
  return (await sql`
    SELECT orig.id AS orig_id, orig.company_id, orig.entry_number,
           contra.id AS contra_id, contra.entry_number AS contra_number
    FROM gl_journal_entries orig
    JOIN gl_journal_entries contra
      ON contra.reversal_of_id = orig.id
     AND contra.company_id = orig.company_id
     AND contra.status = 'posted'
    WHERE orig.status = 'reversed'
    ORDER BY orig.company_id, orig.entry_number
  `) as Row[];
}

/** status='reversed' originals with NO posted contra — report only, never touch. */
async function findOrphans(): Promise<Row[]> {
  if (companyFilter) {
    return (await sql`
      SELECT orig.id AS orig_id, orig.company_id, orig.entry_number, orig.reversed_at
      FROM gl_journal_entries orig
      WHERE orig.status = 'reversed'
        AND orig.company_id = ${companyFilter}::UUID
        AND NOT EXISTS (
          SELECT 1 FROM gl_journal_entries contra
          WHERE contra.reversal_of_id = orig.id
            AND contra.company_id = orig.company_id
            AND contra.status = 'posted'
        )
      ORDER BY orig.company_id, orig.entry_number
    `) as Row[];
  }
  return (await sql`
    SELECT orig.id AS orig_id, orig.company_id, orig.entry_number, orig.reversed_at
    FROM gl_journal_entries orig
    WHERE orig.status = 'reversed'
      AND NOT EXISTS (
        SELECT 1 FROM gl_journal_entries contra
        WHERE contra.reversal_of_id = orig.id
          AND contra.company_id = orig.company_id
          AND contra.status = 'posted'
      )
    ORDER BY orig.company_id, orig.entry_number
  `) as Row[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  try {
    const repairable = await findRepairable();
    const orphans = await findOrphans();

    if (repairable.length === 0 && orphans.length === 0) {
      console.log("No status='reversed' originals found. Nothing to do.");
      process.exit(0);
    }

    console.log(`[Repairable] ${repairable.length} reversed original(s) with a posted contra — flip to 'posted':`);
    for (const r of repairable) {
      console.log(
        `    company ${String(r.company_id)}  ${String(r.entry_number)} (${String(r.orig_id)})  ` +
          `<- contra ${String(r.contra_number)}`,
      );
    }

    if (orphans.length > 0) {
      console.log(
        `\n[Orphans] ${orphans.length} reversed original(s) with NO posted contra — REVIEW MANUALLY, NOT touched:`,
      );
      for (const o of orphans) {
        console.log(`    company ${String(o.company_id)}  ${String(o.entry_number)} (${String(o.orig_id)})`);
      }
    }

    if (!apply) {
      console.log(
        `\nDRY-RUN — nothing was changed. Re-run with --apply to flip the ${repairable.length} repairable original(s).`,
      );
      process.exit(0);
    }

    if (repairable.length === 0) {
      console.log('\nNo repairable originals. Orphans (if any) require manual review.');
      process.exit(0);
    }

    let ok = 0;
    let failed = 0;
    for (const r of repairable) {
      const companyId = String(r.company_id);
      const origId = String(r.orig_id);
      try {
        // reversed -> posted crosses the 'posted' boundary, so the mig-499
        // trigger recomputes gl_account_balances for the affected accounts.
        // reversed_at / reversed_by are preserved (metadata).
        await sql`
          UPDATE gl_journal_entries
          SET status = 'posted', updated_at = NOW()
          WHERE id = ${origId}::UUID AND company_id = ${companyId}::UUID AND status = 'reversed'
        `;
        ok++;
        console.log(`  OK   ${String(r.entry_number)}: status reversed -> posted`);
      } catch (e) {
        failed++;
        console.error(`  FAIL ${String(r.entry_number)}:`, e instanceof Error ? e.message : e);
      }
    }

    console.log(`\nDone. Repaired ${ok}, failed ${failed}.${orphans.length > 0 ? ` ${orphans.length} orphan(s) left for manual review.` : ''}`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('repair-reversed-journal-status failed:', err);
    process.exit(1);
  }
})();
