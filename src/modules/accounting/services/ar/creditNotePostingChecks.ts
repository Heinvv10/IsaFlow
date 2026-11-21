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
import { fetchOpenCustomerInvoices } from './openCustomerInvoices';

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

/**
 * The keys of several invoices, in id order (a duplicate, or a key this transaction holds, is a no-op). A FIFO
 * application reads each typed candidate's remaining credit; an approval of a note linked to that invoice reads the
 * same figure under the key alone, so the walk takes the key too, before any of its invoice rows (#1701 review round 8).
 */
export async function lockInvoicesCreditNotes(invoiceIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(invoiceIds.map((i) => i.toLowerCase()))].sort()) await lockInvoiceCreditNotes(id);
}

/** The keys of a customer's open invoices (the FIFO walk's candidates), read unlocked: only which keys to take. */
export async function lockOpenInvoicesCreditNotes(companyId: string, customerId: string): Promise<void> {
  const open = await fetchOpenCustomerInvoices(companyId, customerId, true, { forUpdate: false });
  await lockInvoicesCreditNotes(open.map((d) => d.invoiceId));
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
