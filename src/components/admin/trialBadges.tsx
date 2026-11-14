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

/** Beside an internal (demo) company's name: listed so it can be managed, left out of every count. */
export function InternalBadge() {
  return <span title="Internal company: not counted in the trial figures" className="ml-2 px-1.5 py-0.5 rounded text-xs font-medium bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300">Internal</span>;
}

/** A company that already pays is no longer on a trial: its trial is neither extended nor converted. */
export function canExtendTrial(t: { trial_state: TrialState }): boolean {
  return t.trial_state !== 'converted';
}

/** Convert needs a company on a trial or active: never a suspended or cancelled one (the server refuses it too). */
export function canConvertTrial(t: { trial_state: TrialState; status: string }): boolean {
  return t.trial_state !== 'converted' && (t.status === 'trial' || t.status === 'active');
}
