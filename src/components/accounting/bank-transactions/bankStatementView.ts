/**
 * bankStatementView - what the selected account's statement figures mean, read once from the bank-account summary and
 * shared by the full statement panel (BankStatementPanel) and the page's one-line summary (BankTxStatsStrip, WP4b), so
 * the two can never disagree about which balance is the basis, which ledger figure it is compared with, or whether a
 * difference may read as reconciled.
 */

import { formatDisplayDate } from '@/utils/dateFormat';
import type { BankAccountSummary } from './useBankTxSummary';

export type StatementRef = NonNullable<BankAccountSummary['statement']['latest']>;

export const NO_BALANCE_REASON: Record<string, string> = {
  not_in_file: 'Not provided by this file format',
  unverified: 'In the file, but its running balance does not agree with its lines — not used',
};
export const NO_BALANCE_UNRECORDED = 'Not recorded for this import';

/** Where a closing balance came from when nothing checked it (bank_import_batches.balance_source, migration 998). */
export const UNCHECKED_SOURCE_CAVEAT: Record<string, string> = {
  pdf_read: "From the PDF's running balance (not checked against a printed closing)",
  ai_read: 'Read from the PDF by AI (not checked against the file)',
};

/** Provenance NOTHING has vouched for: a batch imported before migration 998 (NULL), or a value this code does not know. */
export const UNKNOWN_SOURCE_CAVEAT = 'Where this balance came from was not recorded (not checked)';
/** The only sources a closing balance can have been checked from: a printed closing, or a running balance that agreed with its lines. */
const CHECKED_SOURCES = ['printed', 'running_balance'];
export type Provenance = 'checked' | 'unchecked' | 'unknown';

/** Own keys only: a source of 'constructor' or '__proto__' must read as unknown, not as Object.prototype's members. */
export const own = (table: Record<string, string>, key: string | null): string | undefined =>
  key !== null && Object.hasOwn(table, key) ? table[key] : undefined;

export const provenanceOf = (source: string | null): Provenance =>
  source && CHECKED_SOURCES.includes(source) ? 'checked' : own(UNCHECKED_SOURCE_CAVEAT, source) ? 'unchecked' : 'unknown';

/** The caveat a closing balance carries, or undefined when it was checked. */
export const caveatFor = (source: string | null): string | undefined => {
  const kind = provenanceOf(source);
  return kind === 'checked' ? undefined : kind === 'unchecked' ? own(UNCHECKED_SOURCE_CAVEAT, source) : UNKNOWN_SOURCE_CAVEAT;
};

/** "31 Oct 2026", or the plain words when the batch has no date (the column is NOT NULL; this is defence, not a case). */
export const when = (iso: string): string => (iso ? formatDisplayDate(iso) : 'date not recorded');

export const reasonFor = (ref: StatementRef): string => own(NO_BALANCE_REASON, ref.balanceSource) ?? NO_BALANCE_UNRECORDED;

export interface StatementView {
  /** The last statement WITH a closing balance: the Difference is always measured there, on its own date. */
  basis: StatementRef | null;
  /** The ledger figure the page shows beside it: at the basis's date when the summary has it, else today's. */
  ledgerCents: number;
  ledgerAsAt: string;
  provenance: Provenance;
  /** Only a checked closing can read as reconciled: NULL or unknown provenance is as unvouched-for as an AI read. */
  reconciled: boolean;
  /** "Difference", with what it is measured against or why it is not to be trusted. */
  differenceLabel: string;
}

export function statementView(bank: BankAccountSummary): StatementView {
  const { lastWithBalance: basis, ledgerAtStatementCents, differenceCents } = bank.statement;
  const atStatement = basis !== null && ledgerAtStatementCents !== null;
  const provenance = basis ? provenanceOf(basis.balanceSource) : 'checked';
  return {
    basis,
    ledgerCents: atStatement ? ledgerAtStatementCents : bank.ledgerCents,
    ledgerAsAt: atStatement ? basis.statementDate : bank.ledgerAsAt,
    provenance,
    reconciled: provenance === 'checked' && differenceCents === 0,
    differenceLabel: provenance === 'unchecked' ? 'Difference (not checked)'
      : provenance === 'unknown' ? 'Difference (source not recorded)' : `Difference (as at ${when(basis?.statementDate ?? '')})`,
  };
}
