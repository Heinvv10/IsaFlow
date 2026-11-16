/**
 * BankStatementPanel — the selected account's statement balance beside its ledger balance and the difference, from
 * the bank-account summary (WP1 PR-C; replaces StatementBalanceWidget, which fetched the batches itself and compared
 * a statement with a stale GL figure).
 *
 * A missing figure always says why (the batch's balance_source), never a bare "—". A closing balance nothing checked
 * (pdf_read / ai_read) says so, and its Difference reads "(not checked)" and is never styled as reconciled.
 */

import Link from 'next/link';
import { CalendarDays, Hash } from 'lucide-react';
import { formatDisplayDate } from '@/utils/dateFormat';
import { fmtCents } from './bankCents';
import type { BankAccountSummary } from './useBankTxSummary';

type Ref = NonNullable<BankAccountSummary['statement']['latest']>;

const BOX = 'min-h-[200px] rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]';

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

const reasonFor = (ref: Ref): string =>
  (ref.balanceSource ? NO_BALANCE_REASON[ref.balanceSource] : undefined) ?? NO_BALANCE_UNRECORDED;

function Row({ label, testid, children }: { label: string; testid: string; children: React.ReactNode }) {
  return (
    <div data-testid={testid} className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="text-xs text-[var(--ff-text-tertiary)]">{label}</span>
      <span className="text-right text-sm text-[var(--ff-text-primary)]">{children}</span>
    </div>
  );
}

const Caveat = ({ source }: { source: string | null }) => {
  const text = source ? UNCHECKED_SOURCE_CAVEAT[source] : undefined;
  return text ? <p data-testid="statement-balance-caveat" className="px-4 py-1.5 text-xs text-amber-700 dark:text-amber-400">{text}</p> : null;
};

export function BankStatementPanel({ bank }: { bank: BankAccountSummary }) {
  const { latest, lastWithBalance, ledgerAtStatementCents, differenceCents } = bank.statement;
  if (!latest) {
    return (
      <div className={`${BOX} p-4`} data-testid="bank-statement-panel">
        <p className="text-sm text-[var(--ff-text-secondary)]">No statement imported yet</p>
        <Link href={`/accounting/bank-reconciliation/import?account_id=${bank.id}`}
          className="mt-2 inline-block text-xs text-teal-700 dark:text-teal-400 hover:underline">Import a statement</Link>
      </div>
    );
  }
  const latestHasBalance = latest.closingCents !== null;
  // The Difference is always measured at the last statement WITH a closing balance, on its own date.
  const basis = lastWithBalance;
  // The label and the figure agree: the ledger at the statement date only when the summary has it, else today's.
  const atStatement = basis !== null && ledgerAtStatementCents !== null;
  const unchecked = !!(basis?.balanceSource && UNCHECKED_SOURCE_CAVEAT[basis.balanceSource]);
  const reconciled = !unchecked && differenceCents === 0;
  const diffTone = reconciled ? 'text-teal-700 dark:text-teal-400' : 'text-amber-700 dark:text-amber-400';
  const reconcileHref = basis && basis.closingCents !== null
    ? `/accounting/bank-reconciliation/new?bankAccountId=${bank.id}&statementDate=${basis.statementDate}&statementBalance=${(basis.closingCents / 100).toFixed(2)}`
    : null;

  return (
    <div className={BOX} data-testid="bank-statement-panel">
      <div className="flex items-center justify-between border-b border-[var(--ff-border-light)] px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Statement Balance</h3>
        <span data-testid="statement-format-chip" title={`Statement file format: ${latest.sourceLabel}`}
          className="rounded-full bg-[var(--ff-bg-tertiary)] px-2 py-0.5 text-xs font-medium text-[var(--ff-text-tertiary)]">
          {latest.sourceLabel}
        </span>
      </div>
      <div className="divide-y divide-[var(--ff-border-light)]">
        {latestHasBalance ? (
          <>
            <Row label="Opening" testid="statement-opening">
              {latest.openingCents !== null ? <span className="tabular-nums">{fmtCents(latest.openingCents)}</span>
                : <span className="text-xs text-[var(--ff-text-tertiary)]">Not provided by this file</span>}
            </Row>
            <Row label={`Statement balance (as at ${formatDisplayDate(latest.statementDate)})`} testid="statement-closing">
              <span className="font-medium tabular-nums">{fmtCents(latest.closingCents!)}</span>
            </Row>
            <Caveat source={latest.balanceSource} />
          </>
        ) : (
          <Row label="Statement balance" testid="statement-closing">
            <span data-testid="statement-no-balance-reason" className="text-xs text-[var(--ff-text-tertiary)]">{reasonFor(latest)}</span>
          </Row>
        )}
        {basis && basis.batchId !== latest.batchId && (
          <>
            <Row label={`Last statement balance (as at ${formatDisplayDate(basis.statementDate)})`} testid="statement-last-with-balance">
              <span className="tabular-nums">{fmtCents(basis.closingCents!)}</span>
            </Row>
            <Caveat source={basis.balanceSource} />
          </>
        )}
        <Row label={`Ledger balance (as at ${formatDisplayDate(atStatement ? basis.statementDate : bank.ledgerAsAt)})`} testid="statement-ledger">
          <span className="tabular-nums">{fmtCents(atStatement ? ledgerAtStatementCents : bank.ledgerCents)}</span>
        </Row>
        {basis && differenceCents !== null && (
          <Row label={unchecked ? 'Difference (not checked)' : `Difference (as at ${formatDisplayDate(basis.statementDate)})`} testid="statement-difference">
            <span data-testid="statement-difference-value" className={`font-semibold tabular-nums ${diffTone}`}>{fmtCents(differenceCents)}</span>
            {reconcileHref && (
              <Link href={reconcileHref} data-testid="statement-reconcile-link"
                className="ml-3 text-xs font-normal text-teal-700 dark:text-teal-400 hover:underline">Reconcile</Link>
            )}
          </Row>
        )}
      </div>
      <div className="flex items-center gap-4 border-t border-[var(--ff-border-light)] px-4 py-2 text-xs text-[var(--ff-text-tertiary)]">
        <span className="flex items-center gap-1"><CalendarDays className="h-3 w-3" />{formatDisplayDate(latest.statementDate)}</span>
        <span className="flex items-center gap-1"><Hash className="h-3 w-3" />{latest.lineCount} lines on this statement</span>
        <span className="ml-auto">Imported {formatDisplayDate(latest.importedAt)}</span>
      </div>
    </div>
  );
}
