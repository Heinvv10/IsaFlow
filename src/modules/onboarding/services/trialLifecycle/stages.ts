/**
 * Trial lifecycle email stages (pure). Which stage a trial company is due for on a given day, and
 * whether to send it given the stages already done.
 *
 * - setup_nudge and check_in anchor on the trial start (companies.created_at, written in the same
 *   transaction as trial_ends_at) and apply only while the trial is still running.
 * - ending_soon and ended anchor on trial_ends_at, so an extended trial is told its real end date.
 * - Catch-up: only the HIGHEST due stage is ever sent, and only if no stage at that rank or above is
 *   done. A run that missed days never sends a burst of stale emails.
 */

export const TRIAL_STAGES = ['setup_nudge', 'check_in', 'ending_soon', 'ended'] as const;
export type TrialStage = (typeof TRIAL_STAGES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
export const SETUP_NUDGE_DAY = 3;
export const CHECK_IN_DAY = 10;
export const ENDING_SOON_DAYS = 5;
/** "Trial ended" goes only within this many days of the end, so a long-lapsed trial is never mailed. */
export const ENDED_WINDOW_DAYS = 7;

export function stageRank(stage: TrialStage): number {
  return TRIAL_STAGES.indexOf(stage);
}

export interface TrialDates {
  createdAt: Date;
  trialEndsAt: Date;
  now: Date;
}

/** The highest stage due at `now`, or null when none is (too early, or ended too long ago). */
export function dueStage({ createdAt, trialEndsAt, now }: TrialDates): TrialStage | null {
  const toEnd = trialEndsAt.getTime() - now.getTime();
  if (toEnd <= 0) return -toEnd <= ENDED_WINDOW_DAYS * DAY_MS ? 'ended' : null;
  if (toEnd <= ENDING_SOON_DAYS * DAY_MS) return 'ending_soon';
  const wholeDays = Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS);
  if (wholeDays >= CHECK_IN_DAY) return 'check_in';
  if (wholeDays >= SETUP_NUDGE_DAY) return 'setup_nudge';
  return null;
}

/** `due`, unless a stage at its rank or higher is already done. */
export function stageToSend(due: TrialStage | null, done: readonly TrialStage[]): TrialStage | null {
  if (due === null) return null;
  const rank = stageRank(due);
  return done.some((s) => stageRank(s) >= rank) ? null : due;
}
