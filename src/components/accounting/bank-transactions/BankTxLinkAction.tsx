/**
 * Row action on the bank transactions table: link a line to an asset, or to one of its fuel / service records
 * (mig 853). Unlinked — a truck button. Linked — a chip with the link's label; clicking it opens the same picker,
 * where the link can be changed or removed. A link is an annotation only: it never posts or changes the line.
 */
import { Truck } from 'lucide-react';
import type { BankTxLink } from '@/modules/accounting/types/bank.types';

interface Props {
  link?: BankTxLink;
  onOpen: () => void;
}

export function BankTxLinkAction({ link, onOpen }: Props) {
  if (!link) {
    return (
      <button type="button" onClick={onOpen} title="Link to asset / fuel / service" aria-label="Link to asset / fuel / service"
        className="p-1 rounded hover:bg-sky-500/10 text-sky-400">
        <Truck className="h-3.5 w-3.5" />
      </button>
    );
  }
  const title = link.assetName && link.kind !== 'asset' ? `${link.assetName} — ${link.label}` : link.label;
  return (
    <button type="button" onClick={onOpen} title={`Linked: ${title} — change or unlink`} aria-label={`Linked to ${title}`}
      className="inline-flex items-center gap-1 max-w-[150px] px-1.5 py-0.5 rounded-full bg-sky-500/10 text-sky-400 text-xs hover:bg-sky-500/20">
      <Truck className="h-3 w-3 shrink-0" />
      <span className="truncate">{link.label}</span>
    </button>
  );
}
