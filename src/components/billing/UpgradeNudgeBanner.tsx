/**
 * PAYG upgrade nudge banner.
 * Appears on the dashboard + wallet page when a tenant's monthly Flow usage
 * crosses the yellow / orange / red thresholds from spec §6.
 */

import Link from 'next/link';
import { AlertCircle, TrendingUp } from 'lucide-react';

export type NudgeLevel = 'none' | 'yellow' | 'orange' | 'red';

interface Props {
  level: NudgeLevel;
  monthFlowsUsed: number;
}

const COPY: Record<Exclude<NudgeLevel, 'none'>, { title: string; body: string; classes: string }> = {
  yellow: {
    title: 'You\'re using Flows heavily',
    body:  'You\'ve used {n} Flows this month. Consider moving to Starter if this continues.',
    classes: 'bg-yellow-500/10 border-yellow-500/40 text-yellow-700 dark:text-yellow-300',
  },
  orange: {
    title: 'Upgrading to Starter could save you money',
    body:  'At {n} Flows/month you\'re approaching Starter (R299/mo). Switch anytime — no contract.',
    classes: 'bg-orange-500/10 border-orange-500/40 text-orange-700 dark:text-orange-300',
  },
  red: {
    title: 'Starter plan is now cheaper than your current usage',
    body:  'You\'ve used {n} Flows this month — over R290. Starter costs R299/mo for unlimited usage.',
    classes: 'bg-red-500/10 border-red-500/40 text-red-700 dark:text-red-300',
  },
};

export function UpgradeNudgeBanner({ level, monthFlowsUsed }: Props) {
  if (level === 'none') return null;
  const copy = COPY[level];
  const Icon = level === 'red' ? AlertCircle : TrendingUp;
  return (
    <div className={`flex items-start gap-3 p-4 rounded-lg border ${copy.classes} mb-6`}>
      <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        <h3 className="text-sm font-semibold">{copy.title}</h3>
        <p className="text-sm mt-1 opacity-90">{copy.body.replace('{n}', String(monthFlowsUsed))}</p>
      </div>
      <Link
        href="/accounting/settings/billing/compare?against=starter"
        className="text-sm font-medium underline whitespace-nowrap"
      >
        Compare plans
      </Link>
    </div>
  );
}
