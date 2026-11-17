/**
 * BankTxStatsStrip — the selected account in ONE summary line above the tabs (WP4b): name · Statement · Ledger ·
 * Difference · the line tiles, with a "Details" expander holding the full statement panel. All from the bank-account
 * summary (WP1 PR-C), read through bankStatementView so the line and the panel cannot disagree.
 *
 * Allocated + Suggested + Unallocated + Excluded = the account's posted lines (`data-posted-lines`; each tile carries its
 * figure in `data-count`, which the golden path and the tests sum against). Those four are toggle buttons (aria-pressed)
 * driving the list's status filter (bankTxStatusTiles). Their figures are the WHOLE account's (every tab), which each
 * tile's name and tooltip say; a pressed status tile adds how many of those lines the New-tab list holds. "Awaiting
 * review" is a different cut (the New tab's posted lines), so it is a dashed figure of its own, not a toggle and not
 * part of that sum.
 */

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { BankStatementPanel } from './BankStatementPanel';
import { fmtCents } from './bankCents';
import { caveatFor, reasonFor, statementView, when } from './bankStatementView';
import { statusTilePressed, type StatusTile } from './bankTxStatusTiles';
import type { BankTxTab } from './BankTxTabs';
import type { AllocationFilter } from './useBankTxFilters';
import type { BankAccountSummary } from './useBankTxSummary';

interface Props {
  bank: BankAccountSummary;
  /** The list total while the New tab is open with filters narrowing it and the list loaded, else null. It includes lines pending at the bank. */
  shown: number | null;
  /** Opens the Provisional tab. */
  onShowProvisional: () => void;
  /** The view on screen, for which tile reads as pressed. */
  tab: BankTxTab;
  allocationFilter: AllocationFilter;
  /** A status tile was pressed (the page applies statusTileClick). */
  onTile: (tile: StatusTile) => void;
}

const TILES: { tile: StatusTile; label: string; tone: string }[] = [
  { tile: 'allocated', label: 'Allocated', tone: 'text-teal-700 dark:text-teal-400' },
  { tile: 'suggested', label: 'Suggested', tone: 'text-sky-700 dark:text-sky-400' },
  { tile: 'unallocated', label: 'Unallocated', tone: 'text-amber-800 dark:text-amber-400' },
  { tile: 'excluded', label: 'Excluded', tone: 'text-[var(--ff-text-primary)]' },
];
const CHIP = 'inline-flex min-h-6 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors';
const Sep = () => <span aria-hidden="true" className="text-[var(--ff-text-tertiary)]">·</span>;

function Figures({ bank }: { bank: BankAccountSummary }) {
  const { latest, differenceCents } = bank.statement;
  const v = statementView(bank);
  const caveat = v.basis ? caveatFor(v.basis.balanceSource) : undefined;
  const statement = v.basis
    ? { text: <>Statement <span className="font-semibold tabular-nums text-[var(--ff-text-primary)]">{fmtCents(v.basis.closingCents!)}</span></>,
        title: `Statement balance as at ${when(v.basis.statementDate)}${caveat ? ` - ${caveat}` : ''}` }
    : latest ? { text: <>Statement not available</>, title: reasonFor(latest) } : { text: <>No statement imported</>, title: undefined };
  const shortDiff = v.provenance === 'unchecked' ? 'Difference (not checked)' : v.provenance === 'unknown' ? 'Difference (source not recorded)' : 'Difference';
  return (
    <>
      <span data-testid="summary-statement" title={statement.title}>{statement.text}</span>
      <Sep />
      <span data-testid="summary-ledger" title={`Ledger balance as at ${when(v.ledgerAsAt)}`}>
        Ledger <span className="font-semibold tabular-nums text-[var(--ff-text-primary)]">{fmtCents(v.ledgerCents)}</span>
      </span>
      {v.basis && differenceCents !== null && (
        <>
          <Sep />
          <span data-testid="summary-difference" title={v.differenceLabel}>
            {shortDiff} <span className={`font-semibold tabular-nums ${v.reconciled ? 'text-teal-700 dark:text-teal-400' : 'text-amber-700 dark:text-amber-400'}`}>{fmtCents(differenceCents)}</span>
          </span>
        </>
      )}
    </>
  );
}

export function BankTxStatsStrip({ bank, shown, onShowProvisional, tab, allocationFilter, onTile }: Props) {
  const c = bank.counts;
  const [open, setOpen] = useState(false);
  const detailsId = `bank-statement-details-${bank.id}`;
  return (
    <div data-testid="bank-tx-stats-strip" data-posted-lines={c.posted} className="mt-1.5">
      <div data-testid="bank-summary-line" className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-sm text-[var(--ff-text-secondary)]">
        <span className="min-w-0 max-w-[16rem] truncate font-semibold text-[var(--ff-text-primary)]" title={bank.accountName}>{bank.accountName}</span>
        <span className="font-id text-xs">{bank.accountCode}</span>
        <Sep />
        <Figures bank={bank} />
        <div role="group" aria-label="Show lines by status" className="flex flex-wrap items-center gap-1.5">
          {TILES.map(({ tile, label, tone }) => {
            const n = c[tile];
            const pressed = statusTilePressed({ tab, allocationFilter }, tile);
            return (
              <span key={tile} className="inline-flex items-center gap-1">
                <button type="button" data-testid={`tile-${tile}`} data-count={n} aria-pressed={pressed} onClick={() => onTile(tile)}
                  aria-label={`${n} ${label} on this account (all tabs)${pressed && shown !== null && tile !== 'excluded' ? `, ${shown} in the list` : ''}`}
                  title={`${n} ${label.toLowerCase()} on this account, all tabs. ${tile === 'excluded' ? (pressed ? 'Back to the new lines' : 'Show the excluded lines')
                    : pressed ? 'Show every new line again' : `Show the new lines that are ${label.toLowerCase()}`}`}
                  className={`${CHIP} ${pressed ? 'border-teal-600 bg-teal-500/15 dark:border-teal-400' : 'border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] hover:border-[var(--ff-text-tertiary)]'}`}>
                  <span className={`font-semibold tabular-nums ${tone}`}>{n}</span>
                  <span className="text-[var(--ff-text-secondary)]">{label}</span>
                  {pressed && shown !== null && tile !== 'excluded' && (
                    <span data-testid="tile-in-list" className="text-[var(--ff-text-tertiary)]">· {shown} in the list</span>
                  )}
                </button>
                {tile === 'allocated' && c.provisional > 0 && (
                  <button type="button" onClick={onShowProvisional} data-testid="tile-provisional-link" title="List the provisional lines"
                    className="min-h-6 text-xs text-teal-700 dark:text-teal-400 underline hover:no-underline">
                    incl. {c.provisional} provisional
                  </button>
                )}
              </span>
            );
          })}
          <span data-testid="tile-awaiting-review" data-count={c.awaitingReview}
            className={`${CHIP} border-dashed border-[var(--ff-border-light)]`}>
            <span className="font-semibold tabular-nums text-[var(--ff-text-primary)]">{c.awaitingReview}</span>
            <span>Awaiting review</span>
            {shown !== null && (
              <span data-testid="tile-awaiting-shown" className="text-[var(--ff-text-tertiary)]">
                {/* The New-tab list also carries the lines pending at the bank, which the tile does not count. */}
                {shown} shown{c.pendingAtBank > 0 ? ' (incl. pending at bank)' : ''}
              </span>
            )}
            {c.pendingAtBank > 0 && <span data-testid="tile-pending-at-bank" className="text-[var(--ff-text-tertiary)]">+{c.pendingAtBank} pending at bank</span>}
          </span>
        </div>
        <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(o => !o)}
          className="ml-auto inline-flex min-h-6 items-center gap-1 rounded px-2 text-xs text-teal-700 dark:text-teal-400 hover:bg-teal-500/10">
          Details <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {open && <div id={detailsId} className="mt-2 w-full sm:w-[360px]"><BankStatementPanel bank={bank} /></div>}
    </div>
  );
}
