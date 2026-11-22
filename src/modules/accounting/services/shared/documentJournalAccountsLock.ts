/**
 * Migration 1018, round 15 L1: before a document cancel, a credit-note cancel or a soft delete locks its document row,
 * it takes the accounts of the document's linked journal (gl/ledgerLinkKeys.lockJournalAccounts). An account merge
 * holds its two accounts FOR UPDATE and UPDATEs every document with an item on the source (repointDocumentRows), so a
 * cancel holding that document while its reversal's claim waited on the account deadlocked with it (40P01). The link is
 * read unlocked: the document row lock comes after, and a link that changes in between only means an account locked
 * for nothing (the reversal's claim still locks the head it reverses).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { lockJournalAccounts } from '../gl/ledgerLinkKeys';
import { JournalReversalLockTimeoutError } from '../gl/journalEntryReversalClaim';

export type JournalDocumentTable = 'customer_invoices' | 'supplier_invoices' | 'credit_notes';

async function linkedJournal(companyId: string, table: JournalDocumentTable, id: string): Promise<string | null> {
  const rows = (table === 'customer_invoices'
    ? await sql`SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`
    : table === 'supplier_invoices'
      ? await sql`SELECT gl_journal_entry_id AS je FROM supplier_invoices WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`
      : await sql`SELECT gl_journal_entry_id AS je FROM credit_notes WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  const je = rows[0]?.je;
  return je ? String(je) : null;
}

/** The accounts of a journal about to be reversed, before the caller's document row lock. Busy: the reversal's 503. */
export async function lockJournalAccountsBeforeDocument(journalId: string | null): Promise<void> {
  if (journalId) await lockJournalAccounts([journalId], () => new JournalReversalLockTimeoutError(journalId));
}

/** The accounts of `table`.`id`'s linked journal, before the caller locks that document. */
export async function lockDocumentJournalAccounts(companyId: string, table: JournalDocumentTable, id: string): Promise<void> {
  await lockJournalAccountsBeforeDocument(await linkedJournal(companyId, table, id));
}
