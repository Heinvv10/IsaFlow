/**
 * "From settled bills / invoices": the documents of what a bank line's payment settles (bank/settledDocumentService),
 * under the line's own attachments in the attachments modal and the line drawer. Read-only: Open (a stored link, new
 * tab) and View (a file the viewer can show); never Remove. Each says what it settles and how much this payment paid,
 * "part-paid R x of R y" when it paid only part, and whether the bill is still open after every payment and credit.
 */

import { formatMoney } from '@/lib/money/formatMoney';
import type { Attachment } from '../bankTxAttachmentHelpers';
import { canDownload, previewKind } from '../attachmentPreview';

const LINK = 'shrink-0 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300';

/** "SIV-3 · part-paid R 300.00 of R 1,000.00 · via SP-2" — what one settled document is evidence of. */
export function settledCaption(a: Attachment): string {
  const s = a.settles;
  if (!s) return '';
  const via = a.via?.payment_number ? ` · via ${a.via.payment_number}` : '';
  if (s.entity_type === 'credit_note') {
    return `Credit note ${s.number ?? ''} · ${formatMoney(s.applied)} against ${s.invoice_number ?? 'the invoice'}${via}`;
  }
  const kind = s.entity_type === 'supplier_invoice' ? 'Bill' : 'Invoice';
  // What THIS line paid of the bill, then whether the bill is still open after every payment and credit note.
  const paid = s.applied < s.total
    ? `part-paid ${formatMoney(s.applied)} of ${formatMoney(s.total)}`
    : `paid ${formatMoney(s.applied)}`;
  const open = s.applied < s.total
    ? (s.partial && s.outstanding != null ? ` · ${formatMoney(s.outstanding)} still open` : ' · bill settled')
    : '';
  return `${kind} ${s.number ?? ''} · ${paid}${open}${via}`;
}

interface Props {
  items: Attachment[];
  onView: (a: Attachment) => void;
}

export function SettledEvidenceList({ items, onView }: Props) {
  if (items.length === 0) return null;
  return (
    <section aria-label="From settled bills and invoices" data-testid="settled-evidence" className="space-y-1.5 pt-2">
      <h3 className="text-xs font-semibold text-[var(--ff-text-secondary)]">From settled bills / invoices</h3>
      <ul className="space-y-1.5">
        {items.map((a) => (
          <li key={a.id} className="flex items-baseline justify-between gap-3 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-3 py-2">
            <div className="min-w-0">
              <p title={a.file_name} className="truncate text-xs font-medium text-[var(--ff-text-primary)]">{a.file_name}</p>
              <p className="text-xs text-[var(--ff-text-tertiary)]">{settledCaption(a)}</p>
            </div>
            {previewKind(a.file_url, a.content_type) !== 'none' ? (
              <button type="button" onClick={() => onView(a)} aria-label={`View ${a.file_name}`} className={LINK}>View</button>
            ) : canDownload(a.file_url) ? (
              <a href={a.file_url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${a.file_name}`} className={LINK}>Open</a>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
