/**
 * Status icon + badge styles for fiscal-period rows. Extracted from
 * FiscalPeriodsTab so the parent stays under the 300-line cap.
 */
import type { ReactNode } from 'react';
import { CheckCircle2, Clock, Lock } from 'lucide-react';

export function statusIcon(status: string): ReactNode {
  switch (status) {
    case 'open':    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
    case 'closing': return <Clock className="h-3.5 w-3.5 text-amber-500" />;
    case 'closed':  return <Lock className="h-3.5 w-3.5 text-blue-500" />;
    case 'locked':  return <Lock className="h-3.5 w-3.5 text-red-500" />;
    default:        return null;
  }
}

export function statusBadge(status: string): string {
  switch (status) {
    case 'open':    return 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400';
    case 'closing': return 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400';
    case 'closed':  return 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400';
    case 'locked':  return 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400';
    default:        return 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400';
  }
}
