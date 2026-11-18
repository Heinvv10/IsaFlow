/**
 * BankTxRowMenu - the "⋯" (More actions) menu of a New bank row (WP4b): every action but Accept, so the Actions column
 * stays narrow enough to be on screen at 1366px. An action whose state shows on the row (a link, files, an open client
 * query) is drawn on the row instead (BankTxRowActions) and left out here. Ask client comes first and Exclude last: the
 * two are never next to each other, so a slip cannot exclude a line meant to be asked about.
 */

import { BookmarkPlus, MessageCircle, MoreHorizontal, Paperclip, Scissors, SearchCheck, Truck, X } from 'lucide-react';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import type { BankTx, BankTxTableProps } from './bankTxTypes';

const ICON = 'h-3.5 w-3.5';

export function BankTxRowMenu({ tx, label, table }: { tx: BankTx; label: string; table: BankTxTableProps }) {
  const { onExclude, onSplit, onFindMatch, onAttachments, onAskClient, onCreateRule, onLink } = table;
  const items: ActionMenuItem[] = [];
  if (onAskClient && !tx.queried) items.push({ label: 'Ask client on WhatsApp', icon: <MessageCircle className={ICON} />, onClick: () => onAskClient(tx.id) });
  if (onFindMatch) items.push({ label: 'Find & Match', icon: <SearchCheck className={ICON} />, onClick: () => onFindMatch(tx.id) });
  items.push({ label: 'Split transaction', icon: <Scissors className={ICON} />, onClick: () => { void onSplit(tx.id); } });
  if (onCreateRule) items.push({ label: 'Create rule from this transaction', icon: <BookmarkPlus className={ICON} />, onClick: () => onCreateRule(tx) });
  if (onLink && !tx.link) items.push({ label: 'Link to asset / fuel / service', icon: <Truck className={ICON} />, onClick: () => onLink(tx) });
  if (onAttachments && (tx.attachmentCount ?? 0) === 0) items.push({ label: 'Attachments', icon: <Paperclip className={ICON} />, onClick: () => onAttachments(tx.id) });
  items.push({ label: 'Exclude', icon: <X className={ICON} />, tone: 'destructive', onClick: () => { void onExclude(tx.id); } });
  return (
    <ActionMenu items={items} triggerLabel={`More actions, ${label}`} triggerTitle="More actions"
      trigger={<MoreHorizontal className={ICON} aria-hidden="true" />}
      triggerSizeClassName="h-6 w-6 min-h-6 min-w-6 max-lg:h-11 max-lg:w-11" />
  );
}
