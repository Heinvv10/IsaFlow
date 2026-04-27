/**
 * Month-End Workbench
 * Practice/bookkeeper home screen — close-of-month status across every module
 * for one client, in one place. Per consultant review.
 *
 * Path: /accounting/month-end-workbench
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, AlertCircle, CheckCircle2, Clock, AlertTriangle, Circle, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { STATUS_TONE_CLASSES, type StatusTone } from '@/lib/statusVocabulary';
import type {
  MonthEndWorkbench,
  WorkbenchCard,
  CardStatus,
} from '@/modules/accounting/services/workbench/monthEndWorkbenchService';

function defaultPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function periodLabel(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Workflow-card statuses are a sibling vocabulary to record statuses
// (drafts/approved/posted on invoices). Labels are workflow-progression
// terms ("Ready", "Needs attention"); tone classes come from the central
// palette in statusVocabulary so the colour scheme is consistent.
const STATUS_META: Record<CardStatus, { label: string; tone: StatusTone; iconColor: string; Icon: React.ComponentType<{ className?: string }> }> = {
  ready:       { label: 'Ready',         tone: 'success',   iconColor: 'text-emerald-400', Icon: CheckCircle2 },
  in_progress: { label: 'In progress',   tone: 'progress',  iconColor: 'text-amber-400',   Icon: Clock },
  attention:   { label: 'Needs attention', tone: 'attention', iconColor: 'text-red-400',     Icon: AlertTriangle },
  blocked:     { label: 'Blocked',       tone: 'danger',    iconColor: 'text-rose-400',    Icon: AlertCircle },
  not_started: { label: 'Not started',   tone: 'neutral',   iconColor: 'text-zinc-400',    Icon: Circle },
};

interface CardProps { card: WorkbenchCard }
function CardTile({ card }: CardProps) {
  const meta = STATUS_META[card.status];
  const Icon = meta.Icon;
  const inner = (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 hover:border-zinc-700 hover:bg-zinc-900/60 transition h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${meta.iconColor}`} aria-hidden />
          <h3 className="text-sm font-medium text-zinc-200">{card.title}</h3>
        </div>
        <span className={`text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded border ${STATUS_TONE_CLASSES[meta.tone]}`}>
          {meta.label}
        </span>
      </div>
      <div className="flex-1">
        <div className="text-xl font-semibold text-zinc-100 tabular-nums">{card.primary}</div>
        {card.secondary && (
          <div className="text-xs text-zinc-500 mt-1">{card.secondary}</div>
        )}
      </div>
      {card.href && (
        <div className="flex items-center justify-end mt-3 text-xs text-zinc-400">
          Open <ChevronRight className="w-3 h-3 ml-0.5" />
        </div>
      )}
    </div>
  );
  return card.href ? <Link href={card.href} className="block h-full">{inner}</Link> : inner;
}

interface ApiEnvelope<T> { success: boolean; data: T; error?: { message?: string } }

export default function MonthEndWorkbenchPage() {
  const [period, setPeriod] = useState<string>(defaultPeriod());
  const [data, setData] = useState<MonthEndWorkbench | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/accounting/month-end-workbench?period=${encodeURIComponent(p)}`);
      const json = await res.json() as ApiEnvelope<MonthEndWorkbench>;
      if (!res.ok || !json.success) {
        throw new Error(json.error?.message ?? 'Failed to load workbench');
      }
      setData(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load workbench');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(period); }, [period, load]);

  const readyCount = data?.cards.filter(c => c.status === 'ready').length ?? 0;
  const attentionCount = data?.cards.filter(c => c.status === 'attention').length ?? 0;
  const totalCards = data?.cards.length ?? 0;
  const progressPct = totalCards > 0 ? Math.round((readyCount / totalCards) * 100) : 0;

  return (
    <AppLayout>
      <div className="px-6 py-6 max-w-7xl mx-auto">
        <div className="flex items-start justify-between mb-6 gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-100">Month-End Workbench</h1>
            <p className="text-sm text-zinc-400 mt-1">
              Close-of-period status across every module — {periodLabel(period)}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label htmlFor="workbench-period" className="sr-only">Period</label>
            <input
              id="workbench-period"
              type="month"
              value={period}
              onChange={e => setPeriod(e.target.value)}
              aria-label="Period"
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-sm rounded-md px-3 py-1.5 focus:outline-none focus:border-teal-500"
            />
          </div>
        </div>

        {data && (
          <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-zinc-300">
                <span className="font-medium text-zinc-100">{readyCount}</span> of <span className="font-medium">{totalCards}</span> areas ready · <span className="text-red-300">{attentionCount}</span> need attention
              </div>
              <div className="text-sm tabular-nums">
                {data.trialBalanceBalanced ? (
                  <span className="text-emerald-300">Trial balance balanced ✓</span>
                ) : (
                  <span className="text-red-300">TB out by R{Math.abs(data.trialBalanceDiff).toFixed(2)}</span>
                )}
              </div>
            </div>
            <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center py-20 text-zinc-400">
            <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Loading workbench…
          </div>
        )}

        {error && !loading && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}

        {data && !loading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {data.cards.map(card => (
              <CardTile key={card.id} card={card} />
            ))}
          </div>
        )}

        {data && !loading && (
          <p className="mt-6 text-xs text-zinc-600 text-right">
            Generated {new Date(data.generatedAt).toLocaleString('en-ZA')}
          </p>
        )}
      </div>
    </AppLayout>
  );
}
