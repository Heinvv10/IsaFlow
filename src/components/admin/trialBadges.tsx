/** Badges for the Trials page: days left on a trial, and where each trial stands. */
import type { TrialState } from '@/modules/admin/services/trialQueries';

export function daysLeftBadge(days: number) {
  if (days <= 0)  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300">{days === 0 ? 'Ended today' : `Ended ${-days}d ago`}</span>;
  if (days <= 2)  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-red-500/20 text-red-400">{days}d left</span>;
  if (days <= 5)  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-500/20 text-orange-400">{days}d left</span>;
  if (days <= 7)  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-500/20 text-yellow-400">{days}d left</span>;
  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-green-500/20 text-green-400">{days}d left</span>;
}

export const STATE_BADGE: Record<TrialState, { label: string; style: string }> = {
  active:    { label: 'Trial',     style: 'bg-blue-500/15 text-blue-400' },
  expired:   { label: 'Expired',   style: 'bg-red-500/15 text-red-400' },
  converted: { label: 'Converted', style: 'bg-green-500/15 text-green-400' },
};
