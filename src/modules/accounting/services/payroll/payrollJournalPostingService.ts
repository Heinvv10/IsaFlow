/**
 * Payroll Journal Posting Service
 * Posts (and reverses) a balanced GL journal entry for an approved payroll run.
 *
 * Balance formula:
 *   DR 5200 Labour Costs = total_gross + total_uif + total_sdl − total_eti
 *     (ETI reduces the 5200 debit directly — simplest path, avoids an extra account)
 *   CR 2140 PAYE Payable  = total_paye
 *   CR 2150 UIF Payable   = total_uif × 2  (employee + employer each = total_uif/2 stored;
 *                                            header stores combined, so × 1 here)
 *   CR 2160 SDL Payable   = total_sdl
 *   CR 1110 Bank - Primary = total_net
 *
 * NOTE: total_uif on the run header is the combined employee+employer amount
 * (see calculatePayrollRun: totalUifEmployee + totalUifEmployer).  So we credit
 * 2150 with the full total_uif value — no additional multiplier needed.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry, reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import type { JournalEntryCreateInput, JournalLineInput } from '@/modules/accounting/types/gl.types';
import { getMappingLookup } from './costCentreGlMappingService';
import {
  buildLabourDebitLines,
  type RunLabourLine,
  type AllocationShare,
} from './payrollJournalSplitBuilder';

type Row = DbRow;

// ── Account code constants ───────────────────────────────────────────────────

// 2175 (Other Employee Deductions Payable) is OPTIONAL — only needed when
// voluntary deductions reduce net pay below gross−PAYE−employeeUif. Tenants
// where mig 471 hasn't applied yet can still post statutory-only payroll
// runs; resolveAccountIds returns 2175 only if it exists.
const REQUIRED_ACCOUNT_CODES = ['5200', '2140', '2150', '2160', '1110'] as const;
const OPTIONAL_ACCOUNT_CODES = ['2175'] as const;
type RequiredAccountCode = typeof REQUIRED_ACCOUNT_CODES[number];
type OptionalAccountCode = typeof OPTIONAL_ACCOUNT_CODES[number];
type AccountCode = RequiredAccountCode | OptionalAccountCode;
type AccountMap = Record<RequiredAccountCode, string> & Partial<Record<OptionalAccountCode, string>>;

// ── Helpers ──────────────────────────────────────────────────────────────────

function lastDayOfMonth(year: number, month: number): string {
  // Month is 1-based; day 0 of the next month = last day of this month
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

async function resolveAccountIds(companyId: string): Promise<AccountMap> {
  const allCodes: readonly AccountCode[] = [...REQUIRED_ACCOUNT_CODES, ...OPTIONAL_ACCOUNT_CODES];
  const rows = (await sql`
    SELECT account_code, id
    FROM gl_accounts
    WHERE company_id = ${companyId}::uuid
      AND account_code = ANY(${allCodes as unknown as string[]})
  `) as Row[];

  const map: Partial<AccountMap> = {};
  for (const r of rows) {
    map[String(r.account_code) as AccountCode] = String(r.id);
  }

  const missing = REQUIRED_ACCOUNT_CODES.filter(c => !map[c]);
  if (missing.length > 0) {
    throw new Error(`Missing required GL accounts for payroll journal: ${missing.join(', ')}`);
  }
  return map as AccountMap;
}

// ── postPayrollRunJournal ────────────────────────────────────────────────────

export async function postPayrollRunJournal(
  companyId: string,
  runId: string,
  userId: string,
): Promise<string> {
  // 1. Load run header (company-scoped)
  const headerRows = (await sql`
    SELECT * FROM payroll_run_headers
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];

  if (headerRows.length === 0 || !headerRows[0]) {
    throw new Error(`Payroll run ${runId} not found`);
  }
  const hdr = headerRows[0];

  if (String(hdr.status) !== 'approved') {
    throw new Error(`Payroll run must be 'approved' before posting (current: ${String(hdr.status)})`);
  }

  // 2. Idempotency guard — never double-post
  if (hdr.journal_entry_id != null) {
    log.warn('Payroll journal already posted — skipping duplicate', { runId, journalId: String(hdr.journal_entry_id) }, 'payrollJournal');
    return String(hdr.journal_entry_id);
  }

  const periodYear  = Number(hdr.period_year);
  const periodMonth = Number(hdr.period_month);
  const entryDate   = lastDayOfMonth(periodYear, periodMonth);

  // 3. Resolve GL account UUIDs from codes
  const accts = await resolveAccountIds(companyId);

  // 4. Derive amounts from run header totals (stored as numeric, not cents)
  const totalGross = Number(hdr.total_gross)  || 0;
  const totalPaye  = Number(hdr.total_paye)   || 0;
  const totalUif   = Number(hdr.total_uif)    || 0; // combined employee+employer
  const totalSdl   = Number(hdr.total_sdl)    || 0;
  const totalEti   = Number(hdr.total_eti)    || 0;
  const totalNet   = Number(hdr.total_net)    || 0;

  // DR 5200 = gross + employer UIF (half of combined) + SDL − ETI.
  // Only the employer 1% UIF is a company cost — the employee 1% is deducted
  // from the employee's own gross to net. Both halves are remitted to SARS
  // via CR 2150 below.
  const employerUif = Math.round((totalUif / 2) * 100) / 100;
  const labourDebit = Math.round((totalGross + employerUif + totalSdl - totalEti) * 100) / 100;

  // 5. Build journal lines
  //    The labour debit is split across per-cost-centre GL expense accounts
  //    when mappings exist (mig 458). Unmapped centres + employees with no
  //    centre all collapse into the default 5200 Labour Costs account. The
  //    statutory-credit + bank-credit sides stay single lines because SARS
  //    is paid one cheque per company regardless of cost centre.
  const labourLines = await buildLabourDebitLinesForRun(
    companyId, runId, labourDebit, totalGross, accts['5200'],
  );

  // Other employee deductions (medical aid, pension, RA, etc.) reduce net pay
  // but are not captured in the statutory header totals. Derive the residual
  // and credit it to a single payable account so the journal balances.
  // Per-component GL mapping can split this further in future.
  const employeeUif = Math.round((totalUif / 2) * 100) / 100;
  const otherDeductions = Math.round(
    (totalGross - totalPaye - employeeUif - totalNet) * 100,
  ) / 100;

  const lines: JournalLineInput[] = [
    ...labourLines,
    { glAccountId: accts['2140'], debit: 0, credit: Math.round(totalPaye * 100) / 100, description: 'PAYE payable' },
    { glAccountId: accts['2150'], debit: 0, credit: Math.round(totalUif  * 100) / 100, description: 'UIF payable (employee + employer)' },
    { glAccountId: accts['2160'], debit: 0, credit: Math.round(totalSdl  * 100) / 100, description: 'SDL payable' },
    { glAccountId: accts['1110'], debit: 0, credit: Math.round(totalNet  * 100) / 100, description: 'Net pay — bank disbursement' },
  ];

  if (otherDeductions > 0.005) {
    const otherDeductionsAccountId = accts['2175'];
    if (!otherDeductionsAccountId) {
      throw new Error(
        `Payroll run has R${otherDeductions.toFixed(2)} of voluntary deductions (medical aid, pension, RA, etc.) ` +
        `but the company has no GL account 2175 (Other Employee Deductions Payable). ` +
        `Apply migration 471 or seed account 2175 manually before approving this run.`,
      );
    }
    lines.push({
      glAccountId: otherDeductionsAccountId,
      debit: 0,
      credit: otherDeductions,
      description: 'Other employee deductions (medical aid, pension, RA, etc.)',
    });
  } else if (otherDeductions < -0.005) {
    // Negative residual usually means rounding noise in totalUif/2 or totalEti
    // didn't reconcile cleanly. Log it so the operator can spot a data issue
    // before the JE-balance assertion fails further down.
    log.warn(
      'Negative payroll deduction residual — likely UIF/ETI rounding mismatch',
      { runId, otherDeductions, totalGross, totalPaye, employeeUif, totalNet },
      'payrollJournal',
    );
  }

  // 6. Verify the entry balances before touching GL (avoids orphaned draft entries)
  const totalDebits  = lines.reduce((s, l) => s + l.debit,  0);
  const totalCredits = lines.reduce((s, l) => s + l.credit, 0);
  const diff = Math.abs(Math.round((totalDebits - totalCredits) * 100));
  if (diff > 1) { // allow 1-cent rounding tolerance
    throw new Error(
      `Payroll journal unbalanced by ${(totalDebits - totalCredits).toFixed(2)} ` +
      `(DR ${totalDebits.toFixed(2)} vs CR ${totalCredits.toFixed(2)})`
    );
  }

  const mm = String(periodMonth).padStart(2, '0');
  const description = `Payroll run ${periodYear}-${mm}`;
  const reference   = `PAY-${periodYear}-${mm}`;

  // sourceDocumentId is the FK to captured_documents (OCR source). A payroll
  // run isn't a captured document — the reverse link is payroll_run_headers
  // .journal_entry_id, which we set below. Passing runId here violates the
  // gl_journal_entries → captured_documents FK on every approve.
  const input: JournalEntryCreateInput = {
    entryDate,
    description,
    source: 'auto_payroll',
    lines,
  };

  // 7. Create draft journal entry then post it (matches loans pattern exactly)
  const entry = await createJournalEntry(companyId, input, userId);
  await postJournalEntry(companyId, entry.id, userId);

  // 8. Stamp the run header with the journal entry ID
  await sql`
    UPDATE payroll_run_headers
    SET journal_entry_id = ${entry.id}::uuid,
        updated_at       = NOW()
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `;

  log.info('Payroll journal posted', { companyId, runId, journalId: entry.id, entryDate, reference }, 'payrollJournal');
  return entry.id;
}

/**
 * Builds the labour-debit portion of the journal. Pulls each run line's
 * contribution, scales it to the full labour debit (which includes
 * employer UIF + SDL − ETI — statutory loads that the run-line totals
 * don't carry by themselves), then delegates to the pure split builder.
 *
 * The run-line gross_pay already sums to the header's total_gross, so we
 * apportion labourDebit strictly in proportion to each employee's gross
 * share. This keeps the builder pure + easily testable.
 */
async function buildLabourDebitLinesForRun(
  companyId: string,
  runId: string,
  labourDebit: number,
  totalGross: number,
  defaultAccountId: string,
): Promise<JournalLineInput[]> {
  if (labourDebit === 0 || totalGross === 0) {
    return [{
      glAccountId: defaultAccountId,
      debit: labourDebit,
      credit: 0,
      description: 'Labour costs — gross pay + statutory employer contributions − ETI',
    }];
  }

  const lineRows = (await sql`
    SELECT prl.employee_id,
           prl.gross_pay,
           e.cost_centre_id
      FROM payroll_run_lines prl
      JOIN payroll_employees e ON e.id = prl.employee_id
     WHERE prl.run_id = ${runId}::uuid
  `) as Row[];

  if (lineRows.length === 0) {
    return [{
      glAccountId: defaultAccountId,
      debit: labourDebit,
      credit: 0,
      description: 'Labour costs — gross pay + statutory employer contributions − ETI',
    }];
  }

  const allocRows = (await sql`
    SELECT a.employee_id, a.cost_centre_id, a.percentage
      FROM payroll_employee_cost_allocations a
      JOIN payroll_run_lines prl ON prl.employee_id = a.employee_id
     WHERE prl.run_id = ${runId}::uuid
       AND a.company_id = ${companyId}::uuid
  `) as Row[];

  const mappings = await getMappingLookup(companyId);

  const employeeCostCentre: Record<string, string | null> = {};
  const runLines: RunLabourLine[] = [];
  for (const r of lineRows) {
    const employeeId = String(r.employee_id);
    const grossShare = Number(r.gross_pay) || 0;
    const scaled = Math.round(((grossShare / totalGross) * labourDebit) * 100) / 100;
    employeeCostCentre[employeeId] = r.cost_centre_id == null ? null : String(r.cost_centre_id);
    runLines.push({ employeeId, labourAmount: scaled });
  }

  const employeeAllocations: Record<string, AllocationShare[]> = {};
  for (const r of allocRows) {
    const employeeId = String(r.employee_id);
    if (!employeeAllocations[employeeId]) employeeAllocations[employeeId] = [];
    employeeAllocations[employeeId]!.push({
      costCentreId: String(r.cost_centre_id),
      percentage: Number(r.percentage) || 0,
    });
  }

  return buildLabourDebitLines({
    runLines,
    employeeCostCentre,
    employeeAllocations,
    mappings,
    defaultAccountId,
  });
}

// ── reversePayrollRunJournal ─────────────────────────────────────────────────

export async function reversePayrollRunJournal(
  companyId: string,
  runId: string,
  userId: string,
): Promise<string> {
  const headerRows = (await sql`
    SELECT id, status, journal_entry_id FROM payroll_run_headers
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];

  if (headerRows.length === 0 || !headerRows[0]) {
    throw new Error(`Payroll run ${runId} not found`);
  }
  const hdr = headerRows[0];

  if (hdr.journal_entry_id == null) {
    log.warn('No journal entry to reverse for payroll run', { runId }, 'payrollJournal');
    return '';
  }

  const journalId = String(hdr.journal_entry_id);
  const reversalEntry = await reverseJournalEntry(companyId, journalId, userId);

  // Clear the journal_entry_id so the run can be re-posted after correction
  await sql`
    UPDATE payroll_run_headers
    SET journal_entry_id = NULL,
        updated_at       = NOW()
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `;

  log.info('Payroll journal reversed', { companyId, runId, originalJournalId: journalId, reversalId: reversalEntry.id }, 'payrollJournal');
  return reversalEntry.id;
}
