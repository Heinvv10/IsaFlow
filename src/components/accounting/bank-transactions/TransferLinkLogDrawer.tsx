/**
 * TransferLinkLogDrawer: the automatic transfer links on one bank account (last 90 days), with Undo per batch and
 * per line. Presentational: TransferLinkNotice owns the fetch and the undo requests.
 */

import { Drawer } from '@/components/ui/Drawer';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate, formatDisplayDateTime } from '@/utils/dateFormat';
import type { TransferLinkBatch } from '@/modules/accounting/services/bank/bankTransferLinkLog';

export interface TransferLinkLogDrawerProps {
  open: boolean;
  onClose: () => void;
  batches: TransferLinkBatch[];
  canUndo: boolean;
  /** The batch or link id an undo is running for. */
  busyId: string | null;
  onUndoBatch: (batchId: string) => void;
  onUndoLink: (linkId: string) => void;
  error: string | null;
}

const SOURCE_LABEL: Record<TransferLinkBatch['source'], string> = {
  page_load: 'Opened Bank Transactions',
  import: 'Statement import',
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function BatchSection({ batch, props }: { batch: TransferLinkBatch; props: TransferLinkLogDrawerProps }) {
  const { canUndo, busyId, onUndoBatch, onUndoLink } = props;
  const busy = busyId !== null;
  return (
    <section aria-label={`${formatDisplayDateTime(batch.linkedAt)} · ${SOURCE_LABEL[batch.source]}`}
      className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">
            {formatDisplayDateTime(batch.linkedAt)} · {SOURCE_LABEL[batch.source]}
          </h3>
          <p className="text-xs text-[var(--ff-text-secondary)]">
            {batch.activeCount === 0
              ? 'All undone'
              : `${batch.links.length} ${plural(batch.links.length, 'line linked', 'lines linked')}`}
          </p>
        </div>
        {batch.activeCount > 0 && canUndo && (
          <button type="button" disabled={busy} onClick={() => onUndoBatch(batch.batchId)}
            className="rounded-md border border-[var(--ff-border-light)] px-2 py-1 text-xs font-medium text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-50">
            {busyId === batch.batchId ? 'Undoing...' : 'Undo all'}
          </button>
        )}
      </div>
      <ul className="mt-2 divide-y divide-[var(--ff-border-light)]">
        {batch.links.map((link) => (
          <li key={link.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-[var(--ff-text-primary)] break-words">
                {formatDisplayDate(link.transactionDate)} · {link.description ?? 'No description'}
              </p>
              <p className="text-xs text-[var(--ff-text-secondary)]">
                {formatMoney(link.amount)} ·{' '}
                {link.counterpartyAccountName
                  ? `Linked to a transfer with ${link.counterpartyAccountName}`
                  : 'Linked to a transfer on another account'}
              </p>
            </div>
            {link.undoneAt ? (
              <span className="text-xs text-[var(--ff-text-tertiary)]">Undone {formatDisplayDateTime(link.undoneAt)}</span>
            ) : canUndo ? (
              <button type="button" disabled={busy} onClick={() => onUndoLink(link.id)}
                aria-label={`Undo link for ${link.description ?? 'this line'}`}
                className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50">
                {busyId === link.id ? 'Undoing...' : 'Undo'}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TransferLinkLogDrawer(props: TransferLinkLogDrawerProps) {
  const { open, onClose, batches, error } = props;
  return (
    <Drawer open={open} onClose={onClose} title="Transfer link log" width="md">
      <div className="space-y-3">
        <p className="text-sm text-[var(--ff-text-secondary)]">
          Statement lines that IsaFlow linked to an existing transfer journal. Undo puts a line back exactly as it
          was before the link, and IsaFlow will not link that pair again.
        </p>
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {batches.length === 0 ? (
          <p className="text-sm text-[var(--ff-text-secondary)]">
            No transfers have been linked automatically on this account in the last 90 days.
          </p>
        ) : (
          batches.map((b) => <BatchSection key={b.batchId} batch={b} props={props} />)
        )}
      </div>
    </Drawer>
  );
}
