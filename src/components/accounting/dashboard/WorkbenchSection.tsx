/**
 * WorkbenchSection - Accountant exception cards shown above the Financial Overview.
 *
 * Renders six cards that flag items needing attention:
 *   1. Unreconciled bank transactions  → /accounting/bank-transactions
 *   2. Draft invoices                  → /accounting/customer-invoices?filter=draft
 *   3. AP due this week                → /accounting/supplier-invoices?due_this_week=1
 *   4. Unposted journals               → /accounting/journal-entries
 *   5. Open prior periods              → /accounting/fiscal-periods
 *   6. VAT estimate (current period)   → /accounting/reports/vat-return
 *
 * Loading: skeleton placeholders (no layout shift).
 * Error: small banner - does not block the rest of the dashboard.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Landmark, FileText, Clock, BookOpen, CalendarX2, Receipt,
  AlertCircle, ArrowRight,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

interface WorkbenchMetrics {
  unreconciledBankTxns: number;
  draftInvoices: number;
  apDueThisWeek: number;
  unpostedJournals: number;
  openPriorPeriods: number;
  vatEstimateCurrentPeriod: number;
}

type Severity = 'normal' | 'amber' | 'red';

interface CardDef {
  key: keyof WorkbenchMetrics;
  label: string;
  href: string;
  icon: React.ElementType;
  severity: (value: number) => Severity;
  format?: (value: number) => string;
}

function fmtCurrency(n: number): string {
  const abs = Math.abs(n);
  const prefix = (n < 0 ? '-' : '') + 'R ';
  if (abs >= 1_000_000) return prefix + (abs / 1_000_000).toFixed(1) + 'M';
  if (abs >= 1_000) return prefix + (abs / 1_000).toFixed(1) + 'K';
  return prefix + new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(abs);
}

const CARDS: CardDef[] = [
  {
    key: 'unreconciledBankTxns',
    label: 'Unreconciled bank transactions',
    href: '/accounting/bank-transactions',
    icon: Landmark,
    severity: (v) => (v > 0 ? 'amber' : 'normal'),
  },
  {
    key: 'draftInvoices',
    label: 'Draft invoices',
    href: '/accounting/customer-invoices?filter=draft',
    icon: FileText,
    severity: (v) => (v > 10 ? 'amber' : 'normal'),
  },
  {
    key: 'apDueThisWeek',
    label: 'AP due this week',
    href: '/accounting/supplier-invoices?due_this_week=1',
    icon: Clock,
    severity: (v) => (v > 0 ? 'amber' : 'normal'),
  },
  {
    key: 'unpostedJournals',
    label: 'Unposted journals',
    href: '/accounting/journal-entries',
    icon: BookOpen,
    severity: (v) => (v > 0 ? 'amber' : 'normal'),
  },
  {
    key: 'openPriorPeriods',
    label: 'Open prior periods',
    href: '/accounting/fiscal-periods',
    icon: CalendarX2,
    severity: (v) => (v > 0 ? 'red' : 'normal'),
  },
  {
    key: 'vatEstimateCurrentPeriod',
    label: 'VAT estimate (current period)',
    href: '/accounting/reports/vat-return',
    icon: Receipt,
    severity: () => 'normal',
    format: fmtCurrency,
  },
];

const SEVERITY_STYLES: Record<Severity, { card: string; value: string; badge: string }> = {
  normal: {
    card: 'bg-[var(--ff-bg-secondary)] border-[var(--ff-border-light)]',
    value: 'text-[var(--ff-text-primary)]',
    badge: 'bg-slate-500/10 text-slate-400',
  },
  amber: {
    card: 'bg-amber-900/15 border-amber-500/30',
    value: 'text-amber-300',
    badge: 'bg-amber-500/10 text-amber-400',
  },
  red: {
    card: 'bg-red-900/15 border-red-500/30',
    value: 'text-red-300',
    badge: 'bg-red-500/10 text-red-400',
  },
};

function SkeletonCard() {
  return (
    <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl p-4 animate-pulse">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-4 w-4 rounded bg-slate-700/50" />
        <div className="h-3 w-28 rounded bg-slate-700/50" />
      </div>
      <div className="h-7 w-16 rounded bg-slate-700/50 mb-2" />
      <div className="h-3 w-10 rounded bg-slate-700/30" />
    </div>
  );
}

export function WorkbenchSection() {
  const [metrics, setMetrics] = useState<WorkbenchMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    apiFetch('/api/accounting/dashboard/workbench')
      .then(async (res) => {
        const json = (await res.json()) as { data?: WorkbenchMetrics };
        if (!cancelled) {
          if (!res.ok || !json.data) {
            setError('Could not load workbench metrics');
          } else {
            setMetrics(json.data);
          }
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          log.error('WorkbenchSection: fetch failed', { error: err }, 'workbench-ui');
          setError('Could not load workbench metrics');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  return (
    <section role="region" aria-labelledby="workbench-heading">
      <div className="flex items-center gap-2 mb-3">
        <AlertCircle className="h-4 w-4 text-amber-400" />
        <h2 id="workbench-heading" className="text-xs font-semibold uppercase tracking-widest text-slate-400">
          Today in the books
        </h2>
      </div>

      {error && !loading && (
        <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-900/20 border border-red-500/30 text-red-400 text-xs mb-3">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        {loading
          ? CARDS.map((c) => <SkeletonCard key={c.key} />)
          : CARDS.map((card) => {
              const value = metrics?.[card.key] ?? 0;
              const severity = card.severity(value);
              const styles = SEVERITY_STYLES[severity];
              const Icon = card.icon;
              const displayValue = card.format ? card.format(value) : String(value);

              return (
                <Link
                  key={card.key}
                  href={card.href}
                  aria-label={`${card.label}: ${displayValue}. Click to view.`}
                  className={`group flex flex-col gap-2 rounded-xl border p-4 hover:shadow-md transition-all no-underline ${styles.card}`}
                >
                  <div className="flex items-center gap-2">
                    <div className={`p-1 rounded-md ${styles.badge}`}>
                      <Icon className="h-3.5 w-3.5" />
                    </div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 leading-tight line-clamp-2">
                      {card.label}
                    </p>
                  </div>

                  <p className={`text-2xl font-bold leading-none ${styles.value}`}>
                    {displayValue}
                  </p>

                  <div className="flex items-center gap-1 mt-auto">
                    <span className="text-[10px] text-slate-500 group-hover:text-teal-400 transition-colors">
                      View
                    </span>
                    <ArrowRight className="h-3 w-3 text-slate-500 group-hover:text-teal-400 transition-colors" />
                  </div>
                </Link>
              );
            })}
      </div>
    </section>
  );
}
