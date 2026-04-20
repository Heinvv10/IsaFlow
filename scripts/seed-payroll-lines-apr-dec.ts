/**
 * Seed missing payroll_run_lines for Apr-Dec 2026 on the ISAFlow demo company.
 *
 * Context: an earlier simulator created payroll_run_headers for months 4-12 with
 * artificial totals but zero per-employee lines. UIF declarations therefore show
 * 0 totals. This script:
 *   1. For each month 4-12: resets the header to 'draft' (deletes stale GL journal),
 *      calls calculatePayrollRun (inserts real per-employee lines + correct totals),
 *      then approvePayrollRun (posts a correct GL journal entry).
 *   2. Prints a verification summary.
 *
 * Run:
 *   export $(grep -E '^(MIGRATION_ADMIN_DATABASE_URL|DATABASE_URL)=' .env.local | xargs)
 *   bunx tsx scripts/seed-payroll-lines-apr-dec.ts
 *
 * Uses MIGRATION_ADMIN_DATABASE_URL (BYPASSRLS) for reset queries.
 * Services use the same DATABASE_URL env var via @/lib/neon.
 */

import { createSql, closeSql } from './_pg';
import { calculatePayrollRun } from '../src/modules/accounting/services/payroll/payrollRunService';
import { approvePayrollRun }   from '../src/modules/accounting/services/payroll/payrollApprovalService';

// ── Config ─────────────────────────────────────────────────────────────────────

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_ID   = 'a0000000-0000-0000-0000-000000000001';
const YEAR       = 2026;
const MONTHS     = [4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

// ── Bootstrap ──────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.MIGRATION_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: MIGRATION_ADMIN_DATABASE_URL or DATABASE_URL not set.');
  process.exit(1);
}

// Ensure @/lib/neon picks up the same URL
process.env.DATABASE_URL = DATABASE_URL;

const sql = createSql(DATABASE_URL);

// ── Types ──────────────────────────────────────────────────────────────────────

interface HeaderRow {
  id:               string;
  status:           string;
  journal_entry_id: string | null;
  period_month:     number;
}

interface VerifyRow {
  period_month:   number;
  employee_count: number;
  total_gross:    string;
  total_uif:      string;
  total_net:      string;
  posted:         boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function findHeader(month: number): Promise<HeaderRow | null> {
  const rows = await sql.query<HeaderRow>(
    `SELECT id, status, journal_entry_id, period_month
     FROM payroll_run_headers
     WHERE company_id = $1
       AND period_year  = $2
       AND period_month = $3
     LIMIT 1`,
    [COMPANY_ID, YEAR, month],
  );
  return rows[0] ?? null;
}

async function countLines(runId: string): Promise<number> {
  const rows = await sql.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM payroll_run_lines prl
     JOIN payroll_run_headers prh ON prh.id = prl.run_id
     WHERE prl.run_id    = $1
       AND prh.company_id = $2`,
    [runId, COMPANY_ID],
  );
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Reset an approved/processed header so calculatePayrollRun can operate on it.
 * Deletes the existing (stale) GL journal and sets status back to 'draft'.
 * All queries scoped to COMPANY_ID.
 */
async function resetHeader(runId: string, journalEntryId: string | null): Promise<void> {
  // Unlink the journal_entry_id from the header FIRST so the FK permits deletion of the JE.
  await sql.query(
    `UPDATE payroll_run_headers
     SET journal_entry_id = NULL,
         status           = 'draft',
         updated_at       = NOW()
     WHERE id          = $1
       AND company_id  = $2`,
    [runId, COMPANY_ID],
  );
  if (journalEntryId) {
    await sql.query(
      `DELETE FROM gl_journal_lines WHERE journal_entry_id = $1`,
      [journalEntryId],
    );
    await sql.query(
      `DELETE FROM gl_journal_entries
       WHERE id = $1 AND company_id = $2`,
      [journalEntryId, COMPANY_ID],
    );
  }
  // Also delete any stale run_lines
  await sql.query(
    `DELETE FROM payroll_run_lines WHERE run_id = $1`,
    [runId],
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n=== seed-payroll-lines-apr-dec (company ${COMPANY_ID}) ===\n`);

  for (const month of MONTHS) {
    const header = await findHeader(month);

    if (!header) {
      console.log(`month=${month}: no run header found — skipping`);
      continue;
    }

    const existing = await countLines(header.id);
    if (existing > 0) {
      console.log(
        `month=${month}: already has ${existing} line(s), status=${header.status} — skipping`,
      );
      continue;
    }

    console.log(
      `month=${month}: resetting run ${header.id} ` +
      `(status=${header.status}, je=${header.journal_entry_id ?? 'none'})`,
    );

    await resetHeader(header.id, header.journal_entry_id ?? null);

    // calculatePayrollRun: reads employees, computes lines, sets status='calculated'
    const calculated = await calculatePayrollRun(header.id, COMPANY_ID);

    // approvePayrollRun: status must be in ['draft','calculated','processed']
    const approved = await approvePayrollRun(COMPANY_ID, header.id, ADMIN_ID);

    console.log(
      `month=${month}: lines=${calculated.employeeCount} ` +
      `gross=R${calculated.totalGross.toFixed(2)} ` +
      `paye=R${calculated.totalPaye.toFixed(2)} ` +
      `uif=R${calculated.totalUif.toFixed(2)} ` +
      `net=R${calculated.totalNet.toFixed(2)} ` +
      `je=${approved.journalEntryId}`,
    );
  }

  // ── Verification ────────────────────────────────────────────────────────────

  console.log('\n=== Verification: payroll_run_headers for 2026 ===');

  const verify = await sql.query<VerifyRow>(
    `SELECT
       period_month,
       employee_count,
       total_gross,
       total_uif,
       total_net,
       (journal_entry_id IS NOT NULL) AS posted
     FROM payroll_run_headers
     WHERE company_id = $1
       AND period_year = $2
     ORDER BY period_month`,
    [COMPANY_ID, YEAR],
  );

  console.log('month | employees | gross        | uif       | net          | posted');
  console.log('------+-----------+--------------+-----------+--------------+-------');
  for (const row of verify) {
    const m    = String(row.period_month).padStart(5);
    const emp  = String(row.employee_count).padStart(9);
    const gr   = `R${Number(row.total_gross).toFixed(2)}`.padStart(12);
    const uif  = `R${Number(row.total_uif).toFixed(2)}`.padStart(9);
    const net  = `R${Number(row.total_net).toFixed(2)}`.padStart(12);
    const post = row.posted ? 'yes' : 'NO';
    console.log(`${m} | ${emp} | ${gr} | ${uif} | ${net} | ${post}`);
  }

  await closeSql();
  console.log('\nDone.\n');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
