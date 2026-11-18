/**
 * The Actions cell of a bank transaction row. A new row (WP4b): Accept, then a "⋯" menu (BankTxRowMenu) with find-match,
 * split, rule, link, attach, ask and exclude; what carries state (a link chip, a paperclip with files, an open client
 * query) stays on the row. Undo on an allocated or reviewed one (none on a reconciled one: it is locked until its
 * reconciliation is reopened); the reason on an excluded one.
 */

import { Check, Undo2, MessageCircle } from 'lucide-react';
import { isPendingFeedRow, PendingFeedNotice } from '../bank-transactions/pendingFeedRow';
import { BankTxLinkAction } from '../bank-transactions/BankTxLinkAction';
import { BankTxAttachmentButton } from './BankTxAttachmentButton';
import { ROW_TARGET, TOUCH_ICON } from './bankTxTouch';
import { BankTxRowMenu } from './BankTxRowMenu';
import type { BankTx, BankTxTableProps, RowSelection } from './bankTxTypes';

interface Props {
  tx: BankTx;
  /** rowLabels() entry for this row, for the accessible names. */
  label: string;
  sel: RowSelection | undefined;
  isNew: boolean;
  isAllocated: boolean;
  isExcluded: boolean;
  table: BankTxTableProps;
}

/** The Ask-client button; marked (green, with a dot and its own name) while a query about the line is open. */
function AskClientButton({ tx, label, onAsk }: { tx: BankTx; label: string; onAsk: (id: string) => void }) {
  return (
    <button onClick={() => onAsk(tx.id)} data-queried={tx.queried ? 'true' : undefined}
      title={tx.queried ? 'A query to the client is open - ask again' : 'Ask client on WhatsApp'}
      aria-label={tx.queried ? `Client already asked on WhatsApp, ${label}` : `Ask client on WhatsApp, ${label}`}
      className={`${TOUCH_ICON} ${ROW_TARGET} relative p-1 rounded hover:bg-gray-500/10 ${tx.queried ? 'text-green-700 dark:text-green-400' : 'text-[var(--ff-text-tertiary)]'}`}>
      <MessageCircle className="h-3.5 w-3.5" />
      {tx.queried && <span aria-hidden="true" className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-green-500" />}
    </button>
  );
}

export function BankTxRowActions({ tx, label, sel, isNew, isAllocated, isExcluded, table }: Props) {
  const { onAccept, onUnmatch, onReverse, onAttachments, onAskClient, onLink } = table;

  return (
    <td className="py-1 px-2 text-center">
      {isExcluded ? (
        /* Excluded tab: show reason badge spanning the actions column */
        <div className="flex items-center gap-1 justify-center">
          {tx.excludeReason ? (
            <span
              title={tx.excludeReason}
              className="text-xs px-2 py-0.5 rounded-full bg-red-500/10 text-red-700 dark:text-red-400 max-w-[120px] truncate inline-block"
            >
              {tx.excludeReason}
            </span>
          ) : (
            <span className="text-xs text-[var(--ff-text-tertiary)] italic">Excluded</span>
          )}
          {onAttachments && (tx.attachmentCount ?? 0) > 0 && (
            <BankTxAttachmentButton txId={tx.id} count={tx.attachmentCount} rowName={label} onOpen={onAttachments} />
          )}
        </div>
      ) : (
        <div className="flex items-center gap-0.5 justify-center max-lg:flex-wrap">
          {isNew ? (
            isPendingFeedRow(tx) ? (
              <>
                <PendingFeedNotice />
                {onAttachments && (tx.attachmentCount ?? 0) > 0 && (
                  <BankTxAttachmentButton txId={tx.id} count={tx.attachmentCount} rowName={label} onOpen={onAttachments} />
                )}
              </>
            ) : (
            <>
              <button onClick={() => onAccept(tx.id)} disabled={!sel?.entityId || (table.busyIds?.has(`accept:${tx.id}`) || table.busyIds?.has(`row:${tx.id}`))} aria-busy={(table.busyIds?.has(`accept:${tx.id}`) || table.busyIds?.has(`row:${tx.id}`)) || undefined} title="Accept" aria-label={`Accept, ${label}`}
                className={`${TOUCH_ICON} ${ROW_TARGET} p-1 rounded hover:bg-teal-500/10 text-teal-700 dark:text-teal-400 disabled:opacity-30`}>
                <Check className="h-3.5 w-3.5" />
              </button>
              {onLink && tx.link && <BankTxLinkAction link={tx.link} rowName={label} onOpen={() => onLink(tx)} />}
              {onAttachments && (tx.attachmentCount ?? 0) > 0 && <BankTxAttachmentButton txId={tx.id} count={tx.attachmentCount} rowName={label} onOpen={onAttachments} />}
              {onAskClient && tx.queried && <AskClientButton tx={tx} label={label} onAsk={onAskClient} />}
              <BankTxRowMenu tx={tx} label={label} table={table} />
            </>
            )
          ) : isAllocated ? (
            <>
              {onReverse && (
                <button onClick={() => onReverse(tx.id)} title="Undo allocation" aria-label={`Undo allocation, ${label}`}
                  className={`${TOUCH_ICON} ${ROW_TARGET} p-1 rounded hover:bg-amber-500/10 text-amber-700 dark:text-amber-400`}>
                  <Undo2 className="h-3.5 w-3.5" />
                </button>
              )}
              {onLink && <BankTxLinkAction link={tx.link} rowName={label} onOpen={() => onLink(tx)} />}
              {onAttachments && <BankTxAttachmentButton txId={tx.id} count={tx.attachmentCount} rowName={label} onOpen={onAttachments} />}
              {onAskClient && <AskClientButton tx={tx} label={label} onAsk={onAskClient} />}
            </>
          ) : (
            <>
              {/* A reconciled line is locked: undo needs its reconciliation reopened first (the server refuses it too). */}
              {tx.status !== 'reconciled' && (
                <button onClick={() => onUnmatch(tx.id)} disabled={(table.busyIds?.has(`unmatch:${tx.id}`) || table.busyIds?.has(`row:${tx.id}`))} aria-busy={(table.busyIds?.has(`unmatch:${tx.id}`) || table.busyIds?.has(`row:${tx.id}`)) || undefined} title="Undo allocation" aria-label={`Undo allocation, ${label}`}
                  className={`${TOUCH_ICON} ${ROW_TARGET} p-1 rounded hover:bg-amber-500/10 text-amber-700 dark:text-amber-400`}>
                  <Undo2 className="h-3.5 w-3.5" />
                </button>
              )}
              {onLink && <BankTxLinkAction link={tx.link} rowName={label} onOpen={() => onLink(tx)} />}
              {onAttachments && <BankTxAttachmentButton txId={tx.id} count={tx.attachmentCount} rowName={label} onOpen={onAttachments} />}
              {onAskClient && <AskClientButton tx={tx} label={label} onAsk={onAskClient} />}
            </>
          )}
        </div>
      )}
    </td>
  );
}
