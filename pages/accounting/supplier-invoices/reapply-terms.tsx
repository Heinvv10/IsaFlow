/**
 * Re-apply payment terms (payment-terms programme PR 3): preview which open bills' due dates their suppliers' terms
 * would move, tick, confirm. Only the ticked bills are written, each re-checked; skipped ones say why.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, ArrowLeft, CalendarCog, Loader2 } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SupplierSelect } from '@/components/accounting/supplier-invoices/SupplierSelect';
import { ReapplyTermsTable } from '@/components/accounting/ap/ReapplyTermsTable';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { formatMoney } from '@/lib/money/formatMoney';
import type { ReapplyPreview, ReapplyResult } from '@/modules/accounting/services/ap/reapplyTerms';

const SKIP_WORDS: Record<string, string> = {
  not_found: 'not found', not_open: 'no longer open', terms_not_set: 'supplier terms not set',
  terms_changed: 'terms changed since the preview', already_dated: 'already on that date',
};

export default function ReapplyTermsPage() {
  const [supplierId, setSupplierId] = useState('');
  const [preview, setPreview] = useState<ReapplyPreview | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ReapplyResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/supplier-invoices-reapply-terms${supplierId ? `?supplierId=${encodeURIComponent(supplierId)}` : ''}`);
      await assertOk(res, 'Could not load the preview - try again');
      const json = await res.json();
      const data = (json.data ?? json) as ReapplyPreview;
      setPreview(data);
      setTicked(new Set(data.rows.filter((r) => r.preselected).map((r) => r.id)));
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the preview - try again'));
    } finally {
      setLoading(false);
    }
  }, [supplierId]);
  useEffect(() => { void load(); }, [load]);

  const toggle = (id: string) => setTicked((t) => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = (on: boolean) => setTicked(on && preview ? new Set(preview.rows.map((r) => r.id)) : new Set());

  const apply = async () => {
    if (!preview) return;
    setConfirming(false);
    setSaving(true);
    setError('');
    try {
      const items = preview.rows.filter((r) => ticked.has(r.id)).map((r) => ({
        id: r.id, dueDate: r.newDueDate, fromDueDate: r.currentDueDate, fromSource: r.currentSource,
      }));
      const res = await apiFetch('/api/accounting/supplier-invoices-reapply-terms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }),
      });
      await assertOk(res, 'Could not re-apply the terms - try again');
      const json = await res.json();
      setResult((json.data ?? json) as ReapplyResult);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not re-apply the terms - try again'));
    } finally {
      setSaving(false);
    }
  };

  const tickedTotal = preview ? preview.rows.filter((r) => ticked.has(r.id)).reduce((a, r) => a + r.balance, 0) : 0;
  // Ticked rows the preview left unticked: a hand-set or document date, or a supplier on the old stamped default.
  const overriding = preview ? preview.rows.filter((r) => ticked.has(r.id) && !r.preselected).length : 0;
  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/supplier-invoices" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
            <ArrowLeft className="h-4 w-4" /> Back to supplier invoices
          </Link>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10"><CalendarCog className="h-6 w-6 text-teal-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Re-apply payment terms</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Re-date open bills by each supplier&apos;s own terms. Nothing changes until you confirm.</p>
              </div>
            </div>
            <div className="w-72">
              <SupplierSelect value={supplierId} onChange={(id) => { setResult(null); setSupplierId(id); }} placeholder="All suppliers" />
            </div>
          </div>
        </div>

        <div className="p-6 max-w-7xl space-y-4">
          {error && <div role="alert" className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-700 dark:text-red-400 text-sm"><AlertCircle className="h-4 w-4" /> {error}</div>}
          {result && (
            <div role="status" className="p-3 rounded-lg bg-teal-500/10 text-sm text-[var(--ff-text-primary)]">
              Re-dated {result.updated.length} bill{result.updated.length === 1 ? '' : 's'}.
              {result.skipped.length > 0 && ` Skipped ${result.skipped.length}: ${[...new Set(result.skipped.map((s) => SKIP_WORDS[s.reason] ?? s.reason))].join(', ')}.`}
            </div>
          )}
          {!preview || (loading && !result) ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-teal-500" /></div>
          ) : (
            <>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                {preview.rows.length} bill{preview.rows.length === 1 ? '' : 's'} would move; {preview.unchanged} already match their terms.
                {preview.truncated && ' The list is cut short: choose a supplier to see the rest.'}
              </p>
              {preview.skippedSuppliers.length > 0 && (
                <div className="p-3 rounded-lg bg-amber-500/10 text-sm text-[var(--ff-text-primary)]" data-testid="reapply-skipped">
                  Not re-dated (supplier terms not set): {preview.skippedSuppliers.map((s) => `${s.supplierName} (${s.openBills}, ${formatMoney(s.balance)})`).join('; ')}.
                </div>
              )}
              {preview.rows.length > 0 && (
                <>
                  <ReapplyTermsTable rows={preview.rows} ticked={ticked} onToggle={toggle} onToggleAll={toggleAll} />
                  <div className="flex items-center justify-end gap-3">
                    <span className="text-sm text-[var(--ff-text-secondary)]">{ticked.size} ticked, {formatMoney(tickedTotal)} owing</span>
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                      disabled={saving || ticked.size === 0}
                      onClick={() => setConfirming(true)}
                    >
                      {saving && <Loader2 className="h-4 w-4 animate-spin" />} Re-date {ticked.size} bill{ticked.size === 1 ? '' : 's'}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
        <ConfirmDialog
          open={confirming}
          title="Re-date these bills?"
          message={<>The due dates of <strong>{ticked.size}</strong> bill{ticked.size === 1 ? '' : 's'} change to their suppliers&apos; terms. Each change is recorded in the bill&apos;s history.{overriding > 0 && <> <strong>{overriding}</strong> of them overwrite a date set by hand, from the document, or from terms that may be the old default.</>}</>}
          acceptLabel="Re-date"
          cancelLabel="Cancel"
          onAccept={() => { void apply(); }}
          onCancel={() => setConfirming(false)}
        />
      </div>
    </AppLayout>
  );
}
