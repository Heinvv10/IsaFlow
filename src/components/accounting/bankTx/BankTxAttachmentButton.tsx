/**
 * The paperclip of a bank row. A row with attachments is coloured, numbered from two files up (one is the common
 * case, so a "1" on most rows is noise), and named "N attachment(s) - view",
 * so it reads at a glance and to a screen reader; a row without any keeps the plain grey "Attachments" button.
 * The name follows the grid's "{title}, {row}" convention (bankTxTableNaming.test).
 */

import { Paperclip } from 'lucide-react';

interface Props {
  txId: string;
  count: number | undefined;
  /** rowLabels() entry for this row. */
  rowName: string;
  onOpen: (txId: string) => void;
}

export function BankTxAttachmentButton({ txId, count, rowName, onOpen }: Props) {
  const n = count ?? 0;
  const title = n > 0 ? `${n} attachment${n === 1 ? '' : 's'} - view` : 'Attachments';
  return (
    <button type="button" onClick={() => onOpen(txId)} title={title} aria-label={`${title}, ${rowName}`}
      className={n > 0
        ? 'relative mr-1 p-1 rounded bg-blue-500/10 hover:bg-blue-500/20 text-blue-400'
        : 'p-1 rounded hover:bg-gray-500/10 text-[var(--ff-text-tertiary)]'}>
      <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
      {n > 1 && (
        <span aria-hidden="true"
          className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-0.5 rounded-full bg-blue-500 text-white text-xs leading-4 font-semibold">
          {n > 9 ? '9+' : n}
        </span>
      )}
    </button>
  );
}
