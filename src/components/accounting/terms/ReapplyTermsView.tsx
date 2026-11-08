/**
 * Re-apply payment terms (payment-terms programme PR 3; supplier bills and customer invoices alike): preview which open
 * documents' due dates their contacts' terms would move, tick, confirm. Only the ticked ones are written, each
 * re-checked; skipped ones say why. The two pages (supplier-invoices/reapply-terms, customer-invoices/reapply-terms) give
 * this their words, route and contact picker (`config`, `filter`).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AlertCircle, ArrowLeft, CalendarCog, Loader2 } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ReapplyTermsTable, owingText } from './ReapplyTermsTable';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { formatMoney } from '@/lib/money/formatMoney';
import type { ReapplyResult, ReapplyTermsConfig, TermsPreview } from './reapplyTermsView.types';

interface Props {
  config: ReapplyTermsConfig;
  /** The contact picker, given the chosen id; `onChange('')` clears it. */
  filter: (value: string, onChange: (id: string) => void) => ReactNode;
}

export function ReapplyTermsView({ config, filter }: Props) {
  const { noun, party } = config;
  const partyLower = party.toLowerCase();
  const skipWords: Record<string, string> = {
    not_found: 'not found', not_open: 'no longer open', date_changed: 'due date changed since the preview',
    terms_not_set: `${partyLower} terms not set`, terms_changed: 'terms changed since the preview', already_dated: 'already on that date',
  };
  const [contactId, setContactId] = useState('');
  const [preview, setPreview] = useState<TermsPreview | null>(null);
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
      const res = await apiFetch(`${config.apiPath}${contactId ? `?${config.filterParam}=${encodeURIComponent(contactId)}` : ''}`);
      await assertOk(res, 'Could not load the preview - try again');
      const json = await res.json();
      const data = config.adapt(json.data ?? json);
      setPreview(data);
      setTicked(new Set(data.rows.filter((r) => r.preselected).map((r) => r.id)));
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the preview - try again'));
    } finally {
      setLoading(false);
    }
  }, [config, contactId]);
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
      const res = await apiFetch(config.apiPath, {
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

  const tickedRows = preview ? preview.rows.filter((r) => ticked.has(r.id)) : [];
  // Owing per currency: documents in different currencies are not added together.
  const tickedTotals = [...tickedRows.reduce((m, r) => m.set(r.currencyCode ?? '', (m.get(r.currencyCode ?? '') ?? 0) + r.balance), new Map<string, number>())]
    .map(([currencyCode, balance]) => owingText({ balance, currencyCode: currencyCode || undefined })).join(' + ') || formatMoney(0);
  // Ticked rows the preview left unticked: a hand-set or document date.
  const overriding = tickedRows.filter((r) => !r.preselected).length;
  const plural = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href={config.backHref} className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
            <ArrowLeft className="h-4 w-4" /> {config.backLabel}
          </Link>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10"><CalendarCog className="h-6 w-6 text-teal-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Re-apply payment terms</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Re-date open {noun}s by each {partyLower}&apos;s own terms. Nothing changes until you confirm.</p>
              </div>
            </div>
            <div className="w-72">{filter(contactId, (id) => { setResult(null); setContactId(id); })}</div>
          </div>
        </div>

        <div className="p-6 max-w-7xl space-y-4">
          {error && <div role="alert" className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-700 dark:text-red-400 text-sm"><AlertCircle className="h-4 w-4" /> {error}</div>}
          {result && (
            <div role="status" className="p-3 rounded-lg bg-teal-500/10 text-sm text-[var(--ff-text-primary)]">
              Re-dated {plural(result.updated.length)}.
              {result.skipped.length > 0 && ` Skipped ${result.skipped.length}: ${[...new Set(result.skipped.map((s) => skipWords[s.reason] ?? s.reason))].join(', ')}.`}
            </div>
          )}
          {!preview || (loading && !result) ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-teal-500" /></div>
          ) : (
            <>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                {plural(preview.rows.length)} would move; {preview.unchanged} already match their terms.
                {preview.truncated && ` The list is cut short: choose a ${partyLower} to see the rest.`}
              </p>
              {preview.skipped.length > 0 && (
                <div className="p-3 rounded-lg bg-amber-500/10 text-sm text-[var(--ff-text-primary)]" data-testid="reapply-skipped">
                  Not re-dated ({partyLower} terms not set): {preview.skipped.map((s) => `${s.partyName} (${s.count}, ${formatMoney(s.balance)})`).join('; ')}.
                </div>
              )}
              {preview.rows.length > 0 && (
                <>
                  <ReapplyTermsTable rows={preview.rows} ticked={ticked} onToggle={toggle} onToggleAll={toggleAll} config={config} />
                  <div className="flex items-center justify-end gap-3">
                    <span className="text-sm text-[var(--ff-text-secondary)]">{ticked.size} ticked, {tickedTotals} owing</span>
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                      disabled={saving || ticked.size === 0}
                      onClick={() => setConfirming(true)}
                    >
                      {saving && <Loader2 className="h-4 w-4 animate-spin" />} Re-date {plural(ticked.size)}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
        <ConfirmDialog
          open={confirming}
          title={`Re-date these ${noun}s?`}
          message={<>The due dates of <strong>{ticked.size}</strong> {noun}{ticked.size === 1 ? '' : 's'} change to their {partyLower}s&apos; terms. Each change is recorded in the {noun}&apos;s history.{overriding > 0 && <> <strong>{overriding}</strong> of them overwrite a date set by hand or from the document.</>}</>}
          acceptLabel="Re-date"
          cancelLabel="Cancel"
          onAccept={() => { void apply(); }}
          onCancel={() => setConfirming(false)}
        />
      </div>
    </AppLayout>
  );
}
