/**
 * Payroll Journal Posting Service
 * Posts (and reverses) a balanced GL journal entry for an approved payroll run.
 *
 * The journal ITSELF is built by `payrollJournalBuilder#buildPayrollJournalPlan`,
 * which this service and `post_payroll_journal`'s dry run share. That split is
 * load-bearing: a preview that derived the journal separately would be free to
 * disagree with what actually posts, and a dry run that greenlights a call the
 * live path refuses is worse than no dry run (docs/mcp/CONTRACTS.md §5, §6).
 * Read the builder for the balance formula and for why a deactivated target
 * account is reported rather than filtered.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry, reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import type { JournalEntryCreateInput, JournalLineInput } from '@/modules/accounting/types/gl.types';
import { buildPayrollJournalPlan } from './payrollJournalBuilder';

type Row = DbRow;

/** Blockers the poster answers with its own historical message, for callers that match on it. */
const BLOCKER_MESSAGES: Record<string, (detail: string) => string> = {
  missing_gl_accounts: (d) => d,
  missing_other_deductions_account: (d) => d,
  run_not_approved: (d) => d,
  unbalanced: (d) => d,
};

// ── postPayrollRunJournal ────────────────────────────────────────────────────

/**
 * Posts the payroll journal for an approved run and stamps the run header with
 * the entry id. Idempotent: a run that already carries a journal returns that
 * id without writing.
 *
 * `opts.postingAgent` travels through to `createJournalEntry` so an MCP posting
 * is stamped `mcp:<tool>:v1` rather than falling back to `defaultHumanMeta`,
 * which would label agent work as human and hide it from `list_agent_postings`.
 * Omitted by the UI caller, which keeps human attribution.
 */
export async function postPayrollRunJournal(
  companyId: string,
  runId: string,
  userId: string,
  opts?: { postingAgent?: string },
): Promise<string> {
  const plan = await buildPayrollJournalPlan(companyId, runId);
  if (!plan) throw new Error(`Payroll run ${runId} not found`);

  // Already posted is not an error — the approval path re-runs on retry and
  // relies on this being a no-op.
  if (plan.alreadyPostedJournalId) {
    log.warn(
      'Payroll journal already posted — skipping duplicate',
      { runId, journalId: plan.alreadyPostedJournalId },
      'payrollJournal',
    );
    return plan.alreadyPostedJournalId;
  }

  const blocker = plan.blockers[0];
  if (blocker) {
    const render = BLOCKER_MESSAGES[blocker.code];
    throw new Error(render ? render(blocker.detail) : blocker.detail);
  }

  for (const advisory of plan.advisories) {
    log.warn('Payroll journal advisory', { runId, ...advisory }, 'payrollJournal');
  }

  const lines: JournalLineInput[] = plan.lines.map((l) => ({
    glAccountId: l.glAccountId as string,
    debit: l.debit,
    credit: l.credit,
    description: l.description,
  }));

  // sourceDocumentId is the FK to captured_documents (OCR source). A payroll
  // run isn't a captured document — the reverse link is payroll_run_headers
  // .journal_entry_id, which we set below. Passing runId here violates the
  // gl_journal_entries → captured_documents FK on every approve.
  const input: JournalEntryCreateInput = {
    entryDate: plan.entryDate,
    description: plan.description,
    source: 'auto_payroll',
    lines,
  };

  // JournalEntryMeta.postingAgent is required, so build the meta only when a
  // caller supplied one; omitting it keeps createJournalEntry's human fallback.
  const entry = opts?.postingAgent
    ? await createJournalEntry(companyId, input, userId, { postingAgent: opts.postingAgent })
    : await createJournalEntry(companyId, input, userId);
  await postJournalEntry(companyId, entry.id, userId);

  await sql`
    UPDATE payroll_run_headers
    SET journal_entry_id = ${entry.id}::uuid,
        updated_at       = NOW()
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `;

  log.info(
    'Payroll journal posted',
    { companyId, runId, journalId: entry.id, entryDate: plan.entryDate, reference: plan.reference },
    'payrollJournal',
  );
  return entry.id;
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
