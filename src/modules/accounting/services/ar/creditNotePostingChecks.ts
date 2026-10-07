/**
 * What `approveCreditNote` refuses BEFORE it writes its draft journal, and the
 * wrap for what can only fail after.
 *
 * credit-notes-action answers a refusal 400, and withAuth COMMITs a 4xx — so a
 * refusal raised once the draft journal exists (postJournalEntry refusing a
 * closed period or a deactivated account) left that draft behind as an orphan
 * auto_credit_note journal. The two refusals postJournalEntry makes on the
 * entry's content are therefore asked here first, with the same classes and
 * wording, so they reach the user as the 400 they always were with nothing
 * written. The VAT-lock refusal needs no copy: createJournalEntry raises it
 * before its own insert.
 */
import { sql } from '@/lib/neon';
import { isHeldRowError } from '@/lib/lockTimeout';
import type { JournalLineInput } from '../../types/gl.types';
import { getPeriodStatusForDate } from '../gl/periodStatusService';
import { ClosedFiscalPeriodError, InactiveAccountError } from '../gl/journalEntryPostingGuards';
import { ArPostingAfterWriteError } from './arErrors';

/**
 * Serialise credit-note APPROVALS per linked invoice. Two notes on one invoice
 * approved concurrently each replayed the invoice's legs without the other and
 * took the same revenue twice (a production driven to −1000). Transaction-
 * scoped, so it is released with the request; namespaced, so no other advisory
 * lock key collides with it. Only approveCreditNote takes it, as the first
 * statement after the note row is read — the lock-order census is in
 * ar/.claude.md ("Credit-note approval lock order").
 */
export async function lockInvoiceCreditNotes(invoiceId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`isaflow.credit_note_approve.invoice:${invoiceId.toLowerCase()}`}, 0))`;
}

export async function assertCreditNoteCanPost(
  companyId: string, entryDate: string, lines: readonly JournalLineInput[],
): Promise<void> {
  if (await getPeriodStatusForDate(companyId, entryDate) === 'closed') throw new ClosedFiscalPeriodError('closed');
  const ids = [...new Set(lines.map((l) => l.glAccountId))];
  const inactive = (await sql`
    SELECT account_code, account_name FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[]) AND is_active = false
    ORDER BY account_code
  `) as { account_code: string; account_name: string }[];
  if (inactive.length > 0) {
    throw new InactiveAccountError(inactive.map((a) => ({ code: String(a.account_code), name: String(a.account_name) })));
  }
}

/**
 * A step that runs with the draft journal already written. Its failure is
 * re-raised as ArPostingAfterWriteError (a 5xx: the request rolls back) unless
 * a peer held a row — that keeps its own retryable class (503, also a rollback).
 */
export async function afterJournalWritten<T>(noteNumber: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    if (isHeldRowError(err)) throw err;
    throw new ArPostingAfterWriteError(
      `Credit note ${noteNumber} was not approved: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}
