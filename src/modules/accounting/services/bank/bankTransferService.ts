/**
 * A transfer between two of the company's own bank accounts (Banking > Transfers, POST /api/accounting/bank-transfers).
 *
 * Posted through the journal funnel (Hein, 2026-10-08): createJournalEntry then postJournalEntry, source
 * auto_bank_transfer. So a transfer gets what every journal gets: the ledger-date window, the covering fiscal period
 * (created for a plausible year that has none), the VAT-lock and inactive-account guards, the closed-period refusal,
 * and the JE-<year>-n number the journal trigger mints under 857's '<company>:<year>' key. The route used to INSERT
 * its own header at status 'posted' with a TXF- number from an unlocked MAX + 1, and columns that do not exist.
 *
 * Both accounts must be bank accounts (isBankSubtype). It is still a journal a person composed, with no bank line as
 * evidence (R-035 PR6 round 4: any account can be relabelled bank), so under manual_journal enforcement a rule
 * matching its amount HOLDS it (Hein, forensic-controls step 2, decision 6 — it used to be refused 409): the transfer
 * is saved as a DRAFT journal, marked manual_journal, and an approval request is raised as the person — the
 * manual-journal draft -> request -> approve -> post flow (journal-entries-action posts it once another member
 * approves). manualJournalApprovalCensus lists it GATED (draft + request).
 *
 * Refused from a Login-as (impersonation) session before anything is read (R-032 L5) — so a held transfer's request
 * is always raised by the person themselves.
 *
 * The caller runs this inside a savepoint (withJournalDateRefusal): a refusal raised after the draft exists rolls the
 * draft (and its request) back with it.
 */
import { sql } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import type { DbRow } from '@/lib/neon';
import { isBankSubtype } from '../gl/accountSubtypes';
import { markManualJournal, newManualJournalGate } from '../gl/manualJournalApproval';
import { requestApproval } from '../gl/approvalDocuments';
import { findTransferRecordedFromStatement } from './transferDuplicateGuard';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import type { JournalEntry } from '../../types/gl.types';

/**
 * The statement already recorded a transfer like this one (findTransferRecordedFromStatement): refused before any
 * write until the caller confirms it is a separate movement (`confirmDuplicate`). The route answers it 428.
 */
export class PossibleDuplicateTransferError extends Error {
  constructor(readonly existingEntryNumber: string) {
    super(`A transfer like this is already in the ledger as ${existingEntryNumber}, recorded from the bank statement `
      + 'within ten days. Nothing was posted. If this is a separate transfer, post it again and confirm.');
    this.name = 'PossibleDuplicateTransferError';
  }
}

/** A transfer refused before any write, for a reason the caller can fix: the route answers it 400. */
export class BankTransferRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BankTransferRefusedError';
  }
}

export interface BankTransferInput {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  /** A ledger day (YYYY-MM-DD). */
  transferDate: string;
  reference?: string;
  /** The caller has seen the possible-duplicate warning and confirms this is a separate transfer. */
  confirmDuplicate?: boolean;
}

/**
 * Posted at once, or — under manual-journal enforcement, a rule matching its amount — held: `entry` is the draft
 * journal and `requestId` the approval request raised for it as the person.
 */
export type BankTransferResult = { entry: JournalEntry; fromName: string; toName: string } & (
  | { status: 'posted' }
  | { status: 'awaiting_approval'; requestId: string; requiredRole: string | null });

export async function postBankTransfer(
  companyId: string, input: BankTransferInput, userId: string,
): Promise<BankTransferResult> {
  // R-032 L5: a person posting a journal they composed is refused from a Login-as session, as the journal post is
  // (journal-entries-action); a transfer is not one of the routine postings Hein allowed (sec-nrfa M1, 2026-10-08).
  await assertNotImpersonating();
  const rows = (await sql`
    SELECT id, account_name, account_subtype FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND id = ANY(${[input.fromAccountId, input.toAccountId]}::UUID[])`) as DbRow[];
  const from = rows.find((r) => r.id === input.fromAccountId);
  const to = rows.find((r) => r.id === input.toAccountId);
  if (!from || !to) throw new BankTransferRefusedError('One or both accounts not found');
  if (!isBankSubtype(from.account_subtype) || !isBankSubtype(to.account_subtype)) {
    throw new BankTransferRefusedError('A transfer moves money between two of the company\'s bank accounts: '
      + 'both accounts must be bank accounts');
  }
  // The bank statement may already have recorded this movement as a transfer: typing it again would post it twice
  // (rev-nrfa LOW-1). A second real transfer of the same amount is legitimate too, so the caller confirms instead of
  // being refused outright (brk-nrfa round 3 M2).
  if (!input.confirmDuplicate) {
    const recorded = await findTransferRecordedFromStatement(
      companyId, input.fromAccountId, input.toAccountId, input.amount, input.transferDate);
    if (recorded) throw new PossibleDuplicateTransferError(recorded);
  }
  const fromName = String(from.account_name);
  const toName = String(to.account_name);
  const label = `Transfer: ${fromName} -> ${toName}`;
  const lines = [
    { glAccountId: input.toAccountId, debit: input.amount, credit: 0, description: `Transfer from ${fromName}` },
    { glAccountId: input.fromAccountId, debit: 0, credit: input.amount, description: `Transfer to ${toName}` },
  ];
  // Decided from reads, before the draft exists: enforcement on and an active rule matching the amount — exactly
  // what refused this transfer before decision 6.
  const gate = await newManualJournalGate(companyId, lines);

  // The source stays auto_bank_transfer for a held draft too. The manual-journal gate, the approval request and the
  // journal-entries-action post accept any draft whatever its source (gateManualJournalPost: "ANY draft"), so the
  // approved draft posts by the ordinary route; once posted it is a Transfers-page journal to transferDuplicateGuard
  // (auto_bank_transfer with a reference), so its statement line allocated as a transfer is refused (match it
  // instead); and findTransferRecordedFromStatement reads only POSTED auto_bank_transfer journals with NO reference,
  // so the draft is never mistaken for a transfer the statement recorded. While it waits (pending, or approved and
  // not yet posted), transferDuplicateGuard refuses its statement line allocated as a transfer too (heldTransferDraft).
  const draft = await createJournalEntry(companyId, {
    entryDate: input.transferDate,
    description: input.reference || label,
    reference: label,
    source: 'auto_bank_transfer',
    lines,
  }, userId);
  if (!gate.held) {
    const entry = await postJournalEntry(companyId, draft.id, userId);
    return { status: 'posted', entry, fromName, toName };
  }
  await markManualJournal(companyId, draft.id);
  const request = await requestApproval(companyId, { documentType: 'manual_journal', documentId: draft.id, requestedBy: userId });
  return { status: 'awaiting_approval', entry: draft, fromName, toName, requestId: request.id, requiredRole: request.requiredRole };
}
