/**
 * Payroll GL Posting Service
 *
 * buildPayrollJournalLines — pure function, no side effects.
 * postPayrollRunToGL       — glue: reads run totals, calls the pure builder,
 *                            delegates to createJournalEntry + postJournalEntry.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  getCompletePayrollGlMappings,
  type PayrollGlRole,
} from './payrollGlConfigService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';

type Row = DbRow;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PayrollJournalLine {
  glAccountId: string;
  debit: number;
  credit: number;
  description: string;
}

export interface PayrollRunTotals {
  totalGross: number;
  totalPaye: number;
  totalUif: number;
  totalUifEmployee: number;
  totalUifEmployer: number;
  totalSdl: number;
  totalNet: number;
}

// ── Pure builder ───────────────────────────────────────────────────────────────

const round2dp = (n: number): number => Math.round(n * 100) / 100;

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Builds a balanced set of journal lines from payroll run totals.
 * Zero-amount lines are skipped (e.g. SDL when below threshold → 5 lines).
 * Returns up to 7 lines:
 *   Dr: salaries_expense, uif_employer_expense, sdl_employer_expense
 *   Cr: paye_payable, uif_payable, sdl_payable, net_salaries_payable
 */
export function buildPayrollJournalLines(
  totals: PayrollRunTotals,
  map: Record<PayrollGlRole, string>,
  memo: string,
): PayrollJournalLine[] {
  const push = (
    role: PayrollGlRole,
    amt: number,
    side: 'dr' | 'cr',
  ): PayrollJournalLine | null => {
    const a = round2dp(amt);
    if (a === 0) return null;
    return {
      glAccountId: map[role],
      debit:  side === 'dr' ? a : 0,
      credit: side === 'cr' ? a : 0,
      description: `${role}: ${memo}`,
    };
  };

  const candidates = [
    push('salaries_expense',     totals.totalGross,       'dr'),
    push('uif_employer_expense', totals.totalUifEmployer, 'dr'),
    push('sdl_employer_expense', totals.totalSdl,         'dr'),
    push('paye_payable',         totals.totalPaye,        'cr'),
    push('uif_payable',          totals.totalUif,         'cr'),
    push('sdl_payable',          totals.totalSdl,         'cr'),
    push('net_salaries_payable', totals.totalNet,         'cr'),
  ];

  return candidates.filter((l): l is PayrollJournalLine => l !== null);
}

// ── Glue: read run → build lines → post to GL ─────────────────────────────────

/**
 * Posts a payroll run to the general ledger.
 *
 * 1. Reads aggregated totals from payroll_run_headers.
 * 2. Reads per-employee UIF split from payroll_run_lines.
 * 3. Builds balanced journal lines via buildPayrollJournalLines.
 * 4. Creates a draft JE via createJournalEntry.
 * 5. Posts the JE via postJournalEntry.
 * 6. Writes the JE id back to payroll_run_headers.posted_journal_entry_id.
 *
 * @returns The posted journal entry id.
 */
export async function postPayrollRunToGL(
  companyId: string,
  userId: string,
  runId: string,
): Promise<string> {
  log.info('Posting payroll run to GL', { companyId, runId }, 'payrollGlPostingService');

  // Fetch run header (company-scoped)
  const headerRows = (await sql`
    SELECT period_month, period_year,
           total_gross, total_paye, total_uif, total_sdl, total_net
    FROM payroll_run_headers
    WHERE id = ${runId}::uuid
      AND company_id = ${companyId}::uuid
  `) as Row[];

  const h = headerRows[0];
  if (!h) throw new Error(`Payroll run ${runId} not found for company ${companyId}`);

  // Aggregate per-employee UIF split from lines (company-scoped via JOIN)
  const lineAggRows = (await sql`
    SELECT
      COALESCE(SUM(l.uif_employee), 0) AS uif_employee,
      COALESCE(SUM(l.uif_employer), 0) AS uif_employer
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id
    WHERE l.run_id = ${runId}::uuid
      AND h.company_id = ${companyId}::uuid
  `) as Row[];

  const lineAgg = lineAggRows[0] ?? { uif_employee: 0, uif_employer: 0 };

  // Load GL role → account mapping (throws if any role unmapped)
  const map = await getCompletePayrollGlMappings(companyId);

  const memo = `Payroll run ${MONTHS[Number(h.period_month) - 1]} ${h.period_year}`;

  const lines = buildPayrollJournalLines(
    {
      totalGross:       Number(h.total_gross),
      totalPaye:        Number(h.total_paye),
      totalUif:         Number(h.total_uif),
      totalUifEmployee: Number(lineAgg.uif_employee),
      totalUifEmployer: Number(lineAgg.uif_employer),
      totalSdl:         Number(h.total_sdl),
      totalNet:         Number(h.total_net),
    },
    map,
    memo,
  );

  if (lines.length === 0) {
    throw new Error(`No non-zero journal lines to post for run ${runId}`);
  }

  const today = new Date().toISOString().slice(0, 10);

  // Create draft JE — note: createJournalEntry takes (companyId, input, userId)
  const je = await createJournalEntry(
    companyId,
    {
      entryDate: today,
      description: memo,
      source: 'auto_payroll',
      lines,
    },
    userId,
  );

  // Transition draft → posted (validates double-entry balance)
  await postJournalEntry(companyId, je.id, userId);

  // Write JE id back to the run header
  await sql`
    UPDATE payroll_run_headers
    SET posted_journal_entry_id = ${je.id}::uuid,
        updated_at = NOW()
    WHERE id = ${runId}::uuid
      AND company_id = ${companyId}::uuid
  `;

  log.info('Payroll run posted to GL', { runId, journalEntryId: je.id }, 'payrollGlPostingService');
  return je.id;
}
