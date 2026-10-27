/**
 * The Actions cell of a bank transaction row: accept, find-match, split, rule, link, attach, ask
 * and exclude on a new row; undo / reverse on an allocated or reconciled one; the reason on an
 * excluded one.
 */

import { Check, X, Undo2, Scissors, SearchCheck, RotateCcw, Paperclip, BookmarkPlus, MessageCircle } from 'lucide-react';
import { isPendingFeedRow, PendingFeedNotice } from '../bank-transactions/pendingFeedRow';
import { BankTxLinkAction } from '../bank-transactions/BankTxLinkAction';
import type { BankTx, BankTxTableProps, RowSelection } from './bankTxTypes';

interface Props {
  tx: BankTx;
  sel: RowSelection | undefined;
  isNew: boolean;
  isAllocated: boolean;
  isExcluded: boolean;
  table: BankTxTableProps;
}

export function BankTxRowActions({ tx, sel, isNew, isAllocated, isExcluded, table }: Props) {
  const { onAccept, onExclude, onUnmatch, onSplit, onFindMatch, onReverse, onAttachments, onAskClient, onCreateRule, onLink } = table;

  return (
    <td className="py-2 px-2 text-center">
      {isExcluded ? (
        /* Excluded tab: show reason badge spanning the actions column */
        <div className="flex items-center gap-1 justify-center">
          {tx.excludeReason ? (
            <span
              title={tx.excludeReason}
              className="text-xs px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 max-w-[120px] truncate inline-block"
            >
              {tx.excludeReason}
            </span>
          ) : (
            <span className="text-xs text-[var(--ff-text-tertiary)] italic">Excluded</span>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-0.5 justify-center">
          {isNew ? (
            isPendingFeedRow(tx) ? (
              <PendingFeedNotice />
            ) : (
            <>
              <button onClick={() => onAccept(tx.id)} disabled={!sel?.entityId} title="Accept" aria-label="Accept"
                className="p-1 rounded hover:bg-teal-500/10 text-teal-400 disabled:opacity-30">
                <Check className="h-3.5 w-3.5" />
              </button>
              {onFindMatch && (
                <button onClick={() => onFindMatch(tx.id)} title="Find & Match" aria-label="Find & Match"
                  className="p-1 rounded hover:bg-blue-500/10 text-blue-400">
                  <SearchCheck className="h-3.5 w-3.5" />
                </button>
              )}
              <button onClick={() => onSplit(tx.id)} title="Split transaction" aria-label="Split transaction"
                className="p-1 rounded hover:bg-purple-500/10 text-purple-400">
                <Scissors className="h-3.5 w-3.5" />
              </button>
              {onCreateRule && (
                <button onClick={() => onCreateRule(tx)} title="Create rule from this transaction" aria-label="Create rule from this transaction"
                  className="p-1 rounded hover:bg-yellow-500/10 text-yellow-400">
                  <BookmarkPlus className="h-3.5 w-3.5" />
                </button>
              )}
              {onLink && <BankTxLinkAction link={tx.link} onOpen={() => onLink(tx)} />}
              {onAttachments && (
                <button onClick={() => onAttachments(tx.id)} title="Attachments" aria-label="Attachments"
                  className="p-1 rounded hover:bg-gray-500/10 text-[var(--ff-text-tertiary)]">
                  <Paperclip className="h-3.5 w-3.5" />
                </button>
              )}
              {onAskClient && (
                <button onClick={() => onAskClient(tx.id)} title="Ask client on WhatsApp" aria-label="Ask client on WhatsApp"
                  className="p-1 rounded hover:bg-gray-500/10 text-[var(--ff-text-tertiary)]">
                  <MessageCircle className="h-3.5 w-3.5" />
                </button>
              )}
              <button onClick={() => onExclude(tx.id)} title="Exclude" aria-label="Exclude"
                className="p-1 rounded hover:bg-red-500/10 text-red-400">
                <X className="h-3.5 w-3.5" />
              </button>
            </>
            )
          ) : isAllocated ? (
            <>
              {onReverse && (
                <button onClick={() => onReverse(tx.id)} title="Undo allocation" aria-label="Undo allocation"
                  className="p-1 rounded hover:bg-amber-500/10 text-amber-400">
                  <Undo2 className="h-3.5 w-3.5" />
                </button>
              )}
              {onLink && <BankTxLinkAction link={tx.link} onOpen={() => onLink(tx)} />}
              {onAttachments && (
                <button onClick={() => onAttachments(tx.id)} title="Attachments" aria-label="Attachments"
                  className="p-1 rounded hover:bg-gray-500/10 text-[var(--ff-text-tertiary)]">
                  <Paperclip className="h-3.5 w-3.5" />
                </button>
              )}
              {onAskClient && (
                <button onClick={() => onAskClient(tx.id)} title="Ask client on WhatsApp" aria-label="Ask client on WhatsApp"
                  className="p-1 rounded hover:bg-gray-500/10 text-[var(--ff-text-tertiary)]">
                  <MessageCircle className="h-3.5 w-3.5" />
                </button>
              )}
            </>
          ) : (
            <>
              <button onClick={() => onUnmatch(tx.id)} title="Undo allocation" aria-label="Undo allocation"
                className="p-1 rounded hover:bg-amber-500/10 text-amber-400">
                <Undo2 className="h-3.5 w-3.5" />
              </button>
              {onReverse && tx.status === 'reconciled' && (
                <button onClick={() => onReverse(tx.id)} title="Reverse reconciled" aria-label="Reverse reconciled"
                  className="p-1 rounded hover:bg-red-500/10 text-red-400">
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}
              {onLink && <BankTxLinkAction link={tx.link} onOpen={() => onLink(tx)} />}
              {onAttachments && (
                <button onClick={() => onAttachments(tx.id)} title="Attachments" aria-label="Attachments"
                  className="p-1 rounded hover:bg-gray-500/10 text-[var(--ff-text-tertiary)]">
                  <Paperclip className="h-3.5 w-3.5" />
                </button>
              )}
              {onAskClient && (
                <button onClick={() => onAskClient(tx.id)} title="Ask client on WhatsApp" aria-label="Ask client on WhatsApp"
                  className="p-1 rounded hover:bg-gray-500/10 text-[var(--ff-text-tertiary)]">
                  <MessageCircle className="h-3.5 w-3.5" />
                </button>
              )}
            </>
          )}
        </div>
      )}
    </td>
  );
}
