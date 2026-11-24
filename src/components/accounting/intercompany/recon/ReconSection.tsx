/**
 * The loan reconciliation's three lists (P5): tabs (WAI-ARIA), a paginated table per list, its empty state. Each row names its state in
 * words and links to THIS company's own documents only (its bill and payment when it paid, its invoice when it received; a receipt has no
 * page, so its number is text); the partner's payload text is never a link. There is no action of any kind: the report is read only.
 */
import Link from 'next/link';
import { useRef, type KeyboardEvent } from 'react';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { MAX_RECON_LIST_ROWS, SECTIONS, type ReconItem, type ReconReport, type SectionKey } from '@/modules/accounting/services/intercompany/loanReconTypes';
import { BUCKET_LABELS, MISMATCH_LABELS, SECTION_EMPTY, SECTION_LABELS } from './reconLabels';

const PANEL = 'ic-recon-panel';
const tabId = (k: SectionKey) => `ic-recon-tab-${k}`;
const TAB = 'px-4 py-2 text-sm font-medium border-b-2 -mb-px';

interface Props {
  report: ReconReport;
  onSection: (key: SectionKey) => void;
  onPage: (offset: number) => void;
}

function OwnDocs({ it }: { it: ReconItem }) {
  const o = it.own;
  return (
    <span className="flex flex-col gap-0.5">
      {o.billId && <Link href={`/accounting/supplier-invoices/${o.billId}`} className="text-blue-600 hover:underline">Bill {o.billNumber ?? ''}</Link>}
      {o.paymentId && <Link href={`/accounting/supplier-payments/${o.paymentId}`} className="text-blue-600 hover:underline">Payment {o.paymentNumber ?? ''}</Link>}
      {o.invoiceId && <Link href={`/accounting/customer-invoices/${o.invoiceId}`} className="text-blue-600 hover:underline">Invoice {o.invoiceNumber ?? ''}</Link>}
      {o.receiptId && <span>Receipt {o.receiptNumber ?? ''}</span>}
      {!o.billId && !o.paymentId && !o.invoiceId && !o.receiptId && <span className="text-ink-muted">None found</span>}
    </span>
  );
}

function Row({ it }: { it: ReconItem }) {
  const who = it.direction === 'out' ? 'You paid' : it.direction === 'in' ? 'Partner paid' : '';
  const ref = [it.display.paymentNumber, it.display.payerDocumentNumber].filter(Boolean).join(' / ');
  return (
    <tr className="border-t border-[var(--ff-border-light)] align-top">
      <td className="py-2 pr-3 whitespace-nowrap">{formatDate(it.createdAt)}</td>
      <td className="py-2 pr-3">{who}</td>
      <td className="py-2 pr-3">{it.bucket ? BUCKET_LABELS[it.bucket] : it.kind === 'message' ? 'Partner withheld' : it.kind === 'unsent' ? 'Not sent' : 'Not linked'}</td>
      <td className="py-2 pr-3 text-right whitespace-nowrap">{formatCurrency(it.amount)}</td>
      <td className="py-2 pr-3"><OwnDocs it={it} /></td>
      <td className="py-2 pr-3">{ref || '—'}</td>
      <td className="py-2">
        <p>{it.sentence}</p>
        {it.error && <p className="text-ink-muted">{it.error}</p>}
        {it.mismatches.length > 0 && <p className="text-amber-800">Mismatch: {it.mismatches.map((m) => MISMATCH_LABELS[m]).join(', ')}</p>}
      </td>
    </tr>
  );
}

export function ReconSection({ report, onSection, onPage }: Props) {
  const refs = useRef<Partial<Record<SectionKey, HTMLButtonElement | null>>>({});
  const { key, items, total, limit, offset } = report.section;
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const at = SECTIONS.indexOf(key);
    const next = e.key === 'ArrowRight' ? SECTIONS[(at + 1) % SECTIONS.length] : e.key === 'ArrowLeft' ? SECTIONS[(at + SECTIONS.length - 1) % SECTIONS.length] : undefined;
    if (!next) return;
    e.preventDefault();
    onSection(next);
    refs.current[next]?.focus();
  }
  return (
    <section className="space-y-3">
      <div role="tablist" aria-label="Lists" className="flex gap-1 border-b border-[var(--ff-border-light)]">
        {SECTIONS.map((k) => (
          <button key={k} ref={(el) => { refs.current[k] = el; }} type="button" role="tab" id={tabId(k)} aria-selected={key === k} aria-controls={PANEL}
            tabIndex={key === k ? 0 : -1} onKeyDown={onKeyDown} onClick={() => onSection(k)}
            className={`${TAB} ${key === k ? 'border-blue-500 text-[var(--ff-text-primary)]' : 'border-transparent text-ink-muted hover:text-[var(--ff-text-primary)]'}`}>
            {SECTION_LABELS[k]} ({report.summary.counts[k]})
          </button>
        ))}
      </div>
      {key === 'attention' && (report.summary.truncated.unsent || report.summary.truncated.unlinked) && (
        <p data-testid="recon-truncated" className="text-sm text-amber-800">
          {report.summary.truncated.unsent && `Only the oldest ${MAX_RECON_LIST_ROWS} payments not sent to the partner are listed. `}
          {report.summary.truncated.unlinked && `Only the oldest ${MAX_RECON_LIST_ROWS} paid bills not linked to the partner's invoice are listed.`}
        </p>
      )}
      <div role="tabpanel" id={PANEL} aria-labelledby={tabId(key)} tabIndex={0} data-testid="recon-section" className="outline-none">
        {items.length === 0 ? <p className="py-6 text-sm text-ink-muted">{SECTION_EMPTY[key]}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{SECTION_LABELS[key]}</caption>
              <thead><tr className="text-left text-xs text-ink-muted">
                <th scope="col">Date</th><th scope="col">Direction</th><th scope="col">State</th><th scope="col" className="text-right">Amount</th>
                <th scope="col">Your documents</th><th scope="col">Payer&apos;s reference</th><th scope="col">Details</th>
              </tr></thead>
              <tbody>{items.map((it) => <Row key={`${it.kind}-${it.id}`} it={it} />)}</tbody>
            </table>
          </div>
        )}
      </div>
      {total > 0 && (
        <div className="flex items-center justify-between text-sm">
          <span data-testid="page-info">{offset + 1}-{Math.min(offset + items.length, total)} of {total}</span>
          <span className="flex gap-2">
            <button type="button" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))} className="rounded border px-3 py-1 disabled:opacity-50">Previous</button>
            <button type="button" disabled={offset + limit >= total} onClick={() => onPage(offset + limit)} className="rounded border px-3 py-1 disabled:opacity-50">Next</button>
          </span>
        </div>
      )}
      <p className="text-xs text-ink-muted">Each page is read on its own: two pages are two reads, so a row can move between lists if something changes in between.</p>
    </section>
  );
}
