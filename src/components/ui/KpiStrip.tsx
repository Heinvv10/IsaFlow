/**
 * KpiStrip — horizontal row of small KPI cards used above list-page tables.
 *
 * Each card has a colored icon-chip, a small-caps label, and a primary value.
 * Optional sub-value renders muted underneath the value.
 *
 * Usage:
 *   <KpiStrip items={[
 *     { label: 'Total', value: '34', icon: Users, tone: 'neutral' },
 *     { label: 'Active', value: '32', icon: CheckCircle, tone: 'success' },
 *     { label: 'Overdue', value: 'R 2.8M', sub: '52 invoices', icon: AlertTriangle, tone: 'danger' },
 *   ]} />
 */

import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';

type Tone = 'neutral' | 'success' | 'warning' | 'info' | 'danger';

const TONE_CHIP: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  success: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  warning: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  info:    'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  danger:  'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
};

const TONE_VALUE: Record<Tone, string> = {
  neutral: 'text-slate-900 dark:text-slate-100',
  success: 'text-emerald-700 dark:text-emerald-400',
  warning: 'text-amber-700 dark:text-amber-400',
  info:    'text-blue-700 dark:text-blue-400',
  danger:  'text-rose-700 dark:text-rose-400',
};

export interface KpiItem {
  label: string;
  value: string | number;
  /** Optional smaller sub-value rendered below. */
  sub?: string;
  icon?: LucideIcon;
  tone?: Tone;
}

export interface KpiStripProps {
  items: KpiItem[];
  className?: string;
}

const COL_CLASSES: Record<number, string> = {
  1: 'sm:grid-cols-1',
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-2 lg:grid-cols-4',
  5: 'sm:grid-cols-2 lg:grid-cols-5',
  6: 'sm:grid-cols-2 lg:grid-cols-6',
};

export function KpiStrip({ items, className }: KpiStripProps) {
  if (items.length === 0) return null;
  const cols = COL_CLASSES[Math.min(items.length, 6)] ?? COL_CLASSES[4];
  return (
    <div className={cn('grid gap-3 mb-6 grid-cols-1', cols, className)}>
      {items.map(({ label, value, sub, icon: Icon, tone = 'neutral' }) => (
        <div
          key={label}
          className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"
        >
          {Icon && (
            <div className={cn('p-2 rounded-lg shrink-0', TONE_CHIP[tone])}>
              <Icon className="h-4 w-4" />
            </div>
          )}
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400 leading-none mb-1.5 truncate">
              {label}
            </p>
            <p className={cn('text-lg font-bold leading-none', TONE_VALUE[tone])}>{value}</p>
            {sub && <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">{sub}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

KpiStrip.displayName = 'KpiStrip';
