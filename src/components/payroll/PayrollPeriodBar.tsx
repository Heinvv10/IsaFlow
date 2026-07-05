/**
 * PayrollPeriodBar — VIP-style "active context" strip shown on every
 * /payroll/* page. Mirrors VIP's top-of-screen "Company · Processing Month
 * [N] of [12] · Status" so accountants always know which period they're
 * working in. Click → opens the run detail page.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import {
  Calendar, Lock, Pencil, CircleDot, CheckCircle2, AlertCircle, Loader2,
} from 'lucide-react';

interface PeriodContext {
  companyName: string;
  periodMonth: number;
  periodYear: number;
  periodNumber: number;
  periodsInTaxYear: number;
  runId: string | null;
  status: string;
  taxYearStartMonth: number;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const STATUS_BADGE: Record<string, { bg: string; fg: string; icon: typeof CircleDot; label: string }> = {
  draft:      { bg: 'bg-yellow-500/10',  fg: 'text-yellow-400',  icon: Pencil,        label: 'Draft' },
  calculated: { bg: 'bg-blue-500/10',    fg: 'text-blue-400',    icon: CircleDot,     label: 'Calculated' },
  approved:   { bg: 'bg-teal-500/10',    fg: 'text-teal-400',    icon: CheckCircle2,  label: 'Approved' },
  posted:     { bg: 'bg-emerald-500/10', fg: 'text-emerald-400', icon: Lock,          label: 'Posted (locked)' },
  cancelled:  { bg: 'bg-red-500/10',     fg: 'text-red-400',     icon: AlertCircle,   label: 'Cancelled' },
  none:       { bg: 'bg-gray-500/10',    fg: 'text-gray-400',    icon: CircleDot,     label: 'No run yet' },
};

export function PayrollPeriodBar() {
  const [ctx, setCtx] = useState<PeriodContext | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch('/api/payroll/period-context');
        if (!res.ok) return;
        const json = await res.json() as { data?: PeriodContext };
        if (!cancelled && json.data) setCtx(json.data);
      } catch (err) {
        // Bar is informational; failure shouldn't block the page — log only.
        log.error('Failed to load payroll period context', { error: err }, 'payroll-ui');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="px-6 py-2 border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] flex items-center gap-2 text-xs text-[var(--ff-text-tertiary)]">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading period…
      </div>
    );
  }

  if (!ctx) return null;

  const badge = STATUS_BADGE[ctx.status] ?? STATUS_BADGE.none!;
  const Icon = badge.icon;
  const periodLabel = `${MONTHS[ctx.periodMonth - 1]} ${ctx.periodYear}`;
  const periodCount = `Period ${ctx.periodNumber} of ${ctx.periodsInTaxYear}`;

  const inner = (
    <>
      <Calendar className="h-4 w-4 text-[var(--ff-text-tertiary)] flex-shrink-0" />
      <span className="text-[var(--ff-text-primary)] font-medium truncate">{ctx.companyName}</span>
      <span className="text-[var(--ff-text-tertiary)]">·</span>
      <span className="text-[var(--ff-text-primary)] font-mono">{periodLabel}</span>
      <span className="text-[var(--ff-text-tertiary)] hidden sm:inline">· {periodCount}</span>
      <span className={`ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${badge.bg} ${badge.fg}`}>
        <Icon className="h-3 w-3" /> {badge.label}
      </span>
    </>
  );

  if (ctx.runId) {
    return (
      <Link
        href={`/payroll/runs/${ctx.runId}`}
        className="px-6 py-2 border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] hover:bg-[var(--ff-bg-tertiary)] flex items-center gap-2 text-sm transition-colors"
      >
        {inner}
      </Link>
    );
  }

  return (
    <div className="px-6 py-2 border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] flex items-center gap-2 text-sm">
      {inner}
    </div>
  );
}
