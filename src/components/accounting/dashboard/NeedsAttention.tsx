/**
 * NeedsAttention: the dashboard's one "needs attention" list.
 *
 * Rows come from GET /api/accounting/dashboard/attention (attentionShape),
 * followed by `extra` rows the Overview tab builds from its own counts
 * (provisional entries, missing supplier invoices). Each row is a real link.
 *
 * A failed load shows the message and Retry, never an all-clear; the `extra`
 * rows still show under it, since they do not depend on that route.
 * `setupOpen`: setup tasks are still open, so an empty list is not "All caught up!".
 * `setupUnknown`: the setup checklist has not resolved, so an empty list says neither.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { Skeleton } from '@/components/ui/Skeleton';
import { Money } from '@/components/ui/Money';
import { formatDisplayDate } from '@/utils/dateFormat';
import type {
  AttentionItem,
  AttentionList,
  AttentionSeverity,
} from '@/modules/accounting/services/dashboard/attentionShape';

const LOAD_ERROR = 'Could not load the attention list - try again';
const VISIBLE = 6;

const BADGE: Record<AttentionSeverity, { text: string; cls: string }> = {
  overdue: { text: 'Overdue', cls: 'bg-rose-500/10 text-rose-700 dark:text-rose-400' },
  due_soon: { text: 'Due soon', cls: 'bg-amber-500/10 text-amber-800 dark:text-amber-400' },
  info: { text: 'Open', cls: 'bg-blue-500/10 text-blue-700 dark:text-blue-400' },
};
const ORDER: Record<AttentionSeverity, number> = { overdue: 0, due_soon: 1, info: 2 };

function Row({ item }: { item: AttentionItem }) {
  const badge = BADGE[item.severity];
  return (
    <li>
      <Link
        href={item.href}
        className="group flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 rounded-lg hover:bg-[var(--ff-bg-tertiary)] no-underline"
      >
        <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold ${badge.cls}`}>
          {badge.text}
        </span>
        <span className="min-w-0 flex-1 basis-40">
          <span className="text-sm text-[var(--ff-text-primary)]">{item.label}</span>
          <span className="hidden sm:inline ml-2 text-xs text-[var(--ff-text-tertiary)]">{item.area}</span>
          {item.detail && <span className="block text-xs text-[var(--ff-text-secondary)]">{item.detail}</span>}
        </span>
        {(typeof item.amount === 'number' || item.dueAt) && (
          <span className="flex shrink-0 items-center gap-3 text-xs text-[var(--ff-text-secondary)]">
            {typeof item.amount === 'number' && (
              <Money amount={item.amount} className="text-sm font-medium text-[var(--ff-text-primary)]" />
            )}
            {item.dueAt && <span>Due {formatDisplayDate(item.dueAt)}</span>}
          </span>
        )}
        {/* Decorative; on a phone it would wrap onto a line of its own. */}
        <ChevronRight aria-hidden="true" className="hidden sm:block h-4 w-4 shrink-0 text-[var(--ff-text-tertiary)] group-hover:text-[var(--ff-text-secondary)]" />
      </Link>
    </li>
  );
}

export function NeedsAttention({ setupOpen = false, setupUnknown = false, extra = [] }: {
  setupOpen?: boolean;
  setupUnknown?: boolean;
  extra?: AttentionItem[];
}) {
  const [data, setData] = useState<AttentionList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback((isCancelled: () => boolean = () => false) => {
    setLoading(true);
    setError(null);
    apiFetch('/api/accounting/dashboard/attention')
      .then(async (res) => {
        await assertOk(res, LOAD_ERROR);
        const json = (await res.json()) as { data?: AttentionList };
        if (isCancelled()) return;
        if (!json.data) {
          setData(null);
          setError(LOAD_ERROR);
          log.error('NeedsAttention: response had no data', {}, 'dashboard-ui');
        } else {
          setData(json.data);
        }
      })
      .catch((err: unknown) => {
        if (isCancelled()) return;
        log.error('NeedsAttention: fetch failed', { error: err }, 'dashboard-ui');
        setData(null);
        setError(apiErrorMessage(err, LOAD_ERROR));
      })
      .finally(() => {
        if (!isCancelled()) setLoading(false);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    load(() => cancelled);
    return () => { cancelled = true; };
  }, [load]);

  // Stable sort by severity only: the server already ordered its own rows.
  const rows = data
    ? [...data.items, ...extra]
      .map((item, i) => ({ item, i }))
      .sort((a, b) => ORDER[a.item.severity] - ORDER[b.item.severity] || a.i - b.i)
      .map(({ item }) => item)
    : [];
  const shown = showAll ? rows : rows.slice(0, VISIBLE);
  const ready = !loading && !error && data !== null;
  const empty = ready && rows.length === 0;

  return (
    <section aria-labelledby="needs-attention-heading" className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
      <h2 id="needs-attention-heading" className="text-sm font-semibold text-[var(--ff-text-primary)]">Needs attention</h2>
      {data && !error && (
        <p className="mt-0.5 mb-2 text-xs text-[var(--ff-text-tertiary)]">As at {formatDisplayDate(data.asAt)}. Overdue first.</p>
      )}

      {loading && (
        <div className="space-y-2 px-3 py-2" aria-busy="true">
          <Skeleton variant="text" count={3} className="mb-2" />
        </div>
      )}

      {!loading && error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 px-3 py-3">
          <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
          <button
            type="button"
            onClick={() => load()}
            className="rounded-md border border-[var(--ff-border-light)] px-3 py-1 text-xs font-medium text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)]"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && error && extra.length > 0 && (
        <ul className="space-y-0.5">
          {extra.map((item) => <Row key={item.key} item={item} />)}
        </ul>
      )}

      {empty && setupUnknown && (
        <p role="status" className="px-3 py-4 text-sm text-[var(--ff-text-secondary)]">Daily tasks will show here once your setup status is confirmed</p>
      )}

      {empty && setupOpen && !setupUnknown && (
        <p role="status" className="px-3 py-4 text-sm text-[var(--ff-text-secondary)]">Finish setup to see your daily tasks</p>
      )}

      {empty && !setupOpen && !setupUnknown && (
        <div role="status" className="flex items-center gap-3 px-3 py-4">
          <CheckCircle2 className="h-5 w-5 text-brand-500" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-[var(--ff-text-primary)]">All caught up!</p>
            <p className="text-xs text-[var(--ff-text-secondary)]">Nothing overdue, nothing due this week and nothing waiting in drafts.</p>
          </div>
        </div>
      )}

      {ready && rows.length > 0 && (
        <>
          <ul className="space-y-0.5">
            {shown.map((item) => <Row key={item.key} item={item} />)}
          </ul>
          {rows.length > VISIBLE && (
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((v) => !v)}
              className="mt-2 px-3 py-1 text-xs font-medium text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
            >
              {showAll ? 'Show fewer' : `Show all ${rows.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
