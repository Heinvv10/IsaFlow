/**
 * /accounting/supplier-invoices/intercompany — Bills > Intercompany (P2).
 * The invoices and credit notes other companies sent THIS company through an intercompany connection. A person reviews each one and
 * accepts it (a DRAFT supplier invoice / credit note is created, nothing is approved or posted), rejects it (a reason is required and
 * goes back to the sender) or dismisses it. Messages from a connection set to accept automatically arrive already accepted.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AlertCircle, Link2, X } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/ui';
import { ListSkeleton } from '@/components/ui/ListSkeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusTabs } from '@/components/accounting/supplier-invoices/StatusTabs';
import type { SupplierInvoiceTab } from '@/components/accounting/supplier-invoices/listTypes';
import { InboxTable } from '@/components/accounting/intercompany/InboxTable';
import { InboxReviewModal } from '@/components/accounting/intercompany/InboxReviewModal';
import { InboxRejectModal } from '@/components/accounting/intercompany/InboxRejectModal';
import { useCompany } from '@/contexts/CompanyContext';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { canWrite } from '@/lib/auth/writeRoles';
import { useTimeoutOnce } from '@/hooks/useTimeoutOnce';
import type { AcceptResult, InboxFilter, InboxItem, InboxPage } from '@/modules/accounting/services/intercompany/inboxTypes';

const PER_PAGE = 25;
type Notice = { msg: string; ok: boolean; href?: string };

export default function IntercompanyInboxPage() {
  const router = useRouter();
  const mayWrite = canWrite(useCompany().companyRole);
  const [filter, setFilter] = useState<InboxFilter>('open');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<InboxPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [review, setReview] = useState<InboxItem | null>(null);
  const [rejecting, setRejecting] = useState<InboxItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const afterDelay = useTimeoutOnce();
  // Only the newest load may write state: a slow earlier answer must not replace a newer one.
  const latest = useRef(0);

  const say = useCallback((n: Notice) => { setNotice(n); afterDelay(() => setNotice(null), 8000); }, [afterDelay]);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    setLoading(true);
    try {
      const result = await apiJson(`/api/accounting/intercompany/inbox?filter=${filter}&limit=${PER_PAGE}&offset=${offset}`, undefined,
        'Could not load the intercompany messages - try again');
      if (mine !== latest.current) return;
      setPage(result);
      setError('');
    } catch (err) {
      if (mine !== latest.current) return;
      setError(apiErrorMessage(err, 'Could not load the intercompany messages - try again'));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [filter, offset]);

  useEffect(() => { void load(); }, [load]);

  async function act(item: InboxItem, what: 'dismiss' | 'restore', done: string) {
    setBusyId(item.id);
    try {
      await apiJson(`/api/accounting/intercompany/inbox/${item.id}/${what}`, { method: 'POST' }, `Could not ${what} this message - try again`);
      say({ msg: done, ok: true });
      await load();
    } catch (err) {
      say({ msg: apiErrorMessage(err, `Could not ${what} this message - try again`), ok: false });
    } finally {
      setBusyId(null);
    }
  }

  function accepted(item: InboxItem, result: AcceptResult) {
    setReview(null);
    const href = result.targetDocType === 'supplier_invoice' ? `/accounting/supplier-invoices/${result.targetDocId}` : `/accounting/supplier-credit-notes/${result.targetDocId}`;
    say({ msg: `Accepted ${item.number} as a draft${result.pdfCopied || item.kind === 'credit_note' ? '' : ' (the sender\'s PDF could not be copied)'}.`, ok: true, href });
    void load();
  }

  const items = page?.items ?? [];
  const total = page?.total ?? 0;
  const tab = (t: SupplierInvoiceTab) => void router.push(t === 'all' ? '/accounting/supplier-invoices' : `/accounting/supplier-invoices?status=${t}`);

  return (
    <AppLayout>
      {notice && (
        <div role="status" className={`fixed top-4 right-4 z-50 max-w-sm px-4 py-3 rounded-lg shadow-lg border flex items-start gap-2 ${
          notice.ok ? 'bg-emerald-900/90 border-emerald-700 text-emerald-100' : 'bg-red-900/90 border-red-700 text-red-100'}`}>
          <span className="flex-1 text-sm">{notice.msg}{notice.href && <> <Link href={notice.href} className="underline font-medium">Open the draft</Link></>}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="opacity-70 hover:opacity-100"><X className="h-4 w-4" /></button>
        </div>
      )}
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <PageHeader icon={Link2} title="Intercompany" className="mb-0"
          subtitle="Invoices and credit notes other companies in your group sent you. Accepting one creates a draft; nothing is posted until you approve it."
          actions={<Link href="/accounting/settings/intercompany" className="px-3 py-2 text-sm rounded-lg border border-line text-ink hover:bg-surface-sunken">Connections</Link>} />
        <div className="p-6 space-y-4">
          <StatusTabs active={null} counts={{}} onChange={tab} intercompany={{ count: page?.openCount ?? 0, active: true }} />

          <div className="flex gap-2" role="group" aria-label="Show">
            {(['open', 'handled'] as const).map((f) => (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => { setFilter(f); setOffset(0); }}
                className={`px-3 py-1.5 text-sm rounded-lg border ${filter === f ? 'bg-brand-600 text-white border-brand-600' : 'border-line text-ink hover:bg-surface-sunken'}`}>
                {f === 'open' ? `Needs you${page && page.openCount > 0 ? ` (${page.openCount})` : ''}` : 'Handled'}
              </button>
            ))}
          </div>

          {error && (
            <div role="alert" className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 flex-shrink-0" aria-hidden /><span className="flex-1">{error}</span>
              <button type="button" onClick={() => void load()} className="underline">Try again</button>
            </div>
          )}

          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            {loading && !page ? <ListSkeleton label="Loading intercompany messages" bare />
              : items.length === 0 ? (
                error ? null : (
                  <EmptyState icon={Link2} title={filter === 'open' ? 'Nothing waiting for you' : 'Nothing handled yet'}
                    description={filter === 'open'
                      ? 'When a company connected to you approves an invoice or credit note for you, it arrives here.'
                      : 'Messages you have accepted, rejected or dismissed are listed here.'} />
                )
              ) : (
                <InboxTable items={items} canWrite={mayWrite} busyId={busyId} onReview={setReview} onReject={setRejecting}
                  onDismiss={(i) => void act(i, 'dismiss', `Dismissed ${i.number}. You can restore it under Handled.`)}
                  onRestore={(i) => void act(i, 'restore', `Restored ${i.number}.`)} />
              )}
            {total > PER_PAGE && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 dark:border-slate-800 text-sm text-ink-muted">
                <span>{offset + 1}-{Math.min(offset + PER_PAGE, total)} of {total}</span>
                <div className="flex gap-2">
                  <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PER_PAGE))} className="px-3 py-1.5 rounded-lg border border-line disabled:opacity-50">Previous</button>
                  <button type="button" disabled={offset + PER_PAGE >= total} onClick={() => setOffset(offset + PER_PAGE)} className="px-3 py-1.5 rounded-lg border border-line disabled:opacity-50">Next</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <InboxReviewModal item={review} canWrite={mayWrite} onClose={() => setReview(null)} onAccepted={accepted}
        onReject={(i) => { setReview(null); setRejecting(i); }} />
      <InboxRejectModal item={rejecting} onClose={() => setRejecting(null)}
        onDone={(msg) => { setRejecting(null); say({ msg, ok: true }); void load(); }} />
    </AppLayout>
  );
}
