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
 * evidence: under manual_journal enforcement a rule matching the amount refuses it, from reads, before the first
 * write (409) — as a hand-keyed bank line transferred to another bank account is (bankLineJournalGate, R-035 PR6
 * round 4: any account can be relabelled bank). manualJournalApprovalCensus lists it GATED.
 *
 * The caller runs this inside a savepoint (withJournalDateRefusal): a refusal raised after the draft exists rolls the
 * draft back with it.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { isBankSubtype } from '../gl/accountSubtypes';
import { newManualJournalRefusal } from '../gl/manualJournalApproval';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import type { JournalEntry } from '../../types/gl.types';

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
}

export interface BankTransferResult {
  entry: JournalEntry;
  fromName: string;
  toName: string;
}

export async function postBankTransfer(
  companyId: string, input: BankTransferInput, userId: string,
): Promise<BankTransferResult> {
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
  const refusal = await newManualJournalRefusal(companyId, input.amount, (role, rule, amountText) =>
    `A bank transfer is a journal a person composed, so transferring ${amountText} needs ${role} approval before it `
    + `can be posted (rule: ${rule}). Record it as a journal through Journal Entries and submit it for approval.`);
  if (refusal) throw refusal;
  const fromName = String(from.account_name);
  const toName = String(to.account_name);
  const label = `Transfer: ${fromName} -> ${toName}`;

  const draft = await createJournalEntry(companyId, {
    entryDate: input.transferDate,
    description: input.reference || label,
    reference: label,
    source: 'auto_bank_transfer',
    lines: [
      { glAccountId: input.toAccountId, debit: input.amount, credit: 0, description: `Transfer from ${fromName}` },
      { glAccountId: input.fromAccountId, debit: 0, credit: input.amount, description: `Transfer to ${toName}` },
    ],
  }, userId);
  const entry = await postJournalEntry(companyId, draft.id, userId);
  return { entry, fromName, toName };
}
