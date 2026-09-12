/**
 * "Run rules" as rounds. One request posts at most a bounded number of lines
 * (authorityHoldLimits.ts — the request holds the company authority key for
 * every line it posts) and reports the rest as `autoPostDeferred`; the page
 * keeps requesting while a round makes progress, so one click still runs the
 * whole account. A round that posts nothing but still defers means every line
 * it attempted was refused — stop there and show why, rather than loop.
 */
import { mergeApplyResults, type ApplyResultParts } from './applyToast';

/** What one apply request came back with; `data` undefined for a failed or malformed response. */
export type ApplyRound = { data?: ApplyResultParts & { applied: number } };
export const MAX_APPLY_ROUNDS = 40;

export async function applyRulesUntilSettled(first: ApplyResultParts & { applied: number },
  again: () => Promise<ApplyRound>): Promise<ApplyResultParts> {
  let total: ApplyResultParts = first;
  for (let round = 1; round < MAX_APPLY_ROUNDS && Number(total.autoPostDeferred ?? 0) > 0; round++) {
    const next = await again();
    if (!next.data) break;
    total = mergeApplyResults(total, next.data);
    if (next.data.applied === 0) break;
  }
  return total;
}
