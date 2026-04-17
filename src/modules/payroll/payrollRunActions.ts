/**
 * Payroll Run Actions
 * Complete and reverse payroll runs (GL journal integration).
 * Extracted to keep payrollRunService.ts under 300 lines.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PayrollRun } from './types';
import { mapPayrollRun } from './payrollMappers';
import { resolvePayrollGLAccounts, buildPayrollJournalLines } from './payrollGLHelper';
import { writeAuditEntry } from './payrollAuditService';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export async function completePayrollRun(
  companyId: string,
  runId: string,
  userId: string
): Promise<PayrollRun> {
  try {
    const runRows = (await sql`
      SELECT * FROM payroll_runs WHERE id = ${runId} AND company_id = ${companyId}::UUID
    `) as Row[];
    if (runRows.length === 0) throw new Error('Payroll run not found');
    if (String(runRows[0]!.status) !== 'draft') throw new Error('Can only complete draft payroll runs');

    const run = runRows[0]!;

    // Guard against duplicate completions for the same period. Two runs covering
    // the same pay period can only both exist in 'draft' state; the moment one is
    // completed, further completions for that period are rejected.
    const dupes = (await sql`
      SELECT id, status FROM payroll_runs
      WHERE company_id = ${companyId}::UUID
        AND id != ${runId}::UUID
        AND period_start = ${run.period_start}::DATE
        AND period_end = ${run.period_end}::DATE
        AND status = 'completed'
    `) as Row[];
    if (dupes.length > 0) {
      throw new Error(
        `A payroll run for period ${run.period_start} to ${run.period_end} is already completed (run ${dupes[0]!.id}). Reverse it before completing another.`
      );
    }
    const accounts = await resolvePayrollGLAccounts();
    const lines = buildPayrollJournalLines(accounts, {
      totalGross: Number(run.total_gross),
      totalPaye: Number(run.total_paye),
      totalUifEmployee: Number(run.total_uif_employee),
      totalUifEmployer: Number(run.total_uif_employer),
      totalSdl: Number(run.total_sdl),
    });

    const journalEntry = await createJournalEntry(companyId, {
      entryDate: String(run.period_end),
      description: `Payroll for period ${run.period_start} to ${run.period_end}`,
      source: 'auto_payroll',
      sourceDocumentId: runId,
      lines,
    }, userId);

    await postJournalEntry(companyId, journalEntry.id, userId);

    const updatedRows = (await sql`
      UPDATE payroll_runs SET status='completed', journal_entry_id=${journalEntry.id}::UUID
      WHERE id = ${runId} AND company_id = ${companyId}::UUID RETURNING *
    `) as Row[];

    await writeAuditEntry({
      companyId,
      entityType: 'payroll_run',
      entityId: runId,
      action: 'complete',
      changedBy: userId,
      newValues: { journal_entry_id: journalEntry.id },
    });

    log.info('Payroll run completed', { runId, journalEntryId: journalEntry.id }, 'payroll');
    return mapPayrollRun(updatedRows[0]!);
  } catch (err) {
    log.error('completePayrollRun failed', { runId, error: err }, 'payroll');
    throw err;
  }
}

export async function reversePayrollRun(
  companyId: string,
  runId: string,
  userId: string
): Promise<PayrollRun> {
  try {
    const runRows = (await sql`
      SELECT * FROM payroll_runs WHERE id = ${runId} AND company_id = ${companyId}::UUID
    `) as Row[];
    if (runRows.length === 0) throw new Error('Payroll run not found');
    if (String(runRows[0]!.status) !== 'completed') throw new Error('Can only reverse completed payroll runs');

    if (runRows[0]!.journal_entry_id) {
      const { reverseJournalEntry } = await import('@/modules/accounting/services/gl/journalEntryService');
      await reverseJournalEntry(companyId, String(runRows[0]!.journal_entry_id), userId);
    }

    const updatedRows = (await sql`
      UPDATE payroll_runs SET status='reversed' WHERE id = ${runId} AND company_id = ${companyId}::UUID RETURNING *
    `) as Row[];

    await writeAuditEntry({
      companyId,
      entityType: 'payroll_run',
      entityId: runId,
      action: 'reverse',
      changedBy: userId,
      notes: 'Payroll run reversed — journal entry reversed',
    });

    log.info('Payroll run reversed', { runId }, 'payroll');
    return mapPayrollRun(updatedRows[0]!);
  } catch (err) {
    log.error('reversePayrollRun failed', { runId, error: err }, 'payroll');
    throw err;
  }
}
