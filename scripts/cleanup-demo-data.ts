/**
 * One-shot demo-data cleanup for the ISAFlow Demo company.
 *
 * Surfaced by the multi-module browser audit (2026-04-18):
 *   - 21 stress-test gl_accounts polluting the CoA / CaseWare export
 *   - 48 duplicate payroll-run periods (every period appears twice)
 *   - 37 credit_notes (type=supplier) with NULL supplier_id
 *
 * Run with: bun run scripts/cleanup-demo-data.ts            (dry-run)
 *           bun run scripts/cleanup-demo-data.ts --apply    (commit)
 *
 * Idempotent: safe to re-run after --apply (will report 0 rows affected).
 * Targets ISAFlow Demo only — does NOT touch other tenants.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { sql } from '../src/lib/neon';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001'; // ISAFlow Demo
const APPLY = process.argv.includes('--apply');

type Row = Record<string, unknown>;

async function reportAndMaybeDelete(
  label: string,
  preview: Promise<Row[]>,
  apply: () => Promise<unknown>,
) {
  const rows = await preview;
  console.log(`\n${label}: ${rows.length} row(s) match`);
  rows.slice(0, 5).forEach(r => console.log('  •', JSON.stringify(r)));
  if (rows.length > 5) console.log(`  • … and ${rows.length - 5} more`);

  if (!APPLY) {
    console.log('  (dry-run — pass --apply to delete)');
    return;
  }
  await apply();
  console.log('  ✓ deleted');
}

(async () => {
  console.log(APPLY ? '🟢 APPLY mode' : '🟡 DRY-RUN mode (use --apply to commit)');
  console.log(`Target company: ${COMPANY_ID} (ISAFlow Demo)`);

  // ── 1. Stress-test accounts ────────────────────────────────────────────────
  await reportAndMaybeDelete(
    '1. Stress-test gl_accounts',
    sql`
      SELECT account_code, account_name FROM gl_accounts
      WHERE company_id = ${COMPANY_ID}
        AND (account_name ~* 'stress|^E2E|test\\s*\\d{4,}' OR account_code ~ '^(ST|E2E|TEST)')
      ORDER BY account_code
    ` as Promise<Row[]>,
    async () => {
      // Only delete if no journal lines reference the account; otherwise leave
      // it (FK violation would abort the cleanup).
      await sql`
        DELETE FROM gl_accounts
        WHERE company_id = ${COMPANY_ID}
          AND (account_name ~* 'stress|^E2E|test\\s*\\d{4,}' OR account_code ~ '^(ST|E2E|TEST)')
          AND id NOT IN (SELECT DISTINCT gl_account_id FROM gl_journal_lines WHERE company_id = ${COMPANY_ID})
      `;
    },
  );

  // ── 2. Duplicate payroll runs ─────────────────────────────────────────────
  // Strategy: for each (company_id, period_start), keep the row with the
  // lowest created_at (the original seed); delete subsequent duplicates.
  await reportAndMaybeDelete(
    '2. Duplicate payroll_runs (period × company)',
    sql`
      WITH ranked AS (
        SELECT id, period_start::date AS ps,
          ROW_NUMBER() OVER (PARTITION BY company_id, period_start::date ORDER BY created_at ASC, id ASC) AS rn
        FROM payroll_runs WHERE company_id = ${COMPANY_ID}
      )
      SELECT ps, COUNT(*) AS dup_count FROM ranked WHERE rn > 1
      GROUP BY ps ORDER BY ps
    ` as Promise<Row[]>,
    async () => {
      await sql`
        DELETE FROM payroll_runs WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY company_id, period_start::date ORDER BY created_at ASC, id ASC) AS rn
            FROM payroll_runs WHERE company_id = ${COMPANY_ID}
          ) ranked WHERE rn > 1
        )
      `;
    },
  );

  // ── 3. NULL supplier_id supplier credit-notes ─────────────────────────────
  await reportAndMaybeDelete(
    '3. credit_notes (type=supplier) with NULL supplier_id',
    sql`
      SELECT id, credit_note_number, total_amount FROM credit_notes
      WHERE company_id = ${COMPANY_ID} AND type = 'supplier' AND supplier_id IS NULL
      ORDER BY credit_note_number
    ` as Promise<Row[]>,
    async () => {
      // These records are unusable without a supplier link. Demo data only —
      // delete rather than try to guess the supplier.
      await sql`
        DELETE FROM credit_notes
        WHERE company_id = ${COMPANY_ID} AND type = 'supplier' AND supplier_id IS NULL
      `;
    },
  );

  console.log('\nDone.');
})();
