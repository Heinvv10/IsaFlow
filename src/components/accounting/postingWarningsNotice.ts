/**
 * Telling the person that a posting went through but part of what they asked
 * for was NOT applied: a cost centre picked on a bill, a claim or a recurring
 * template that is inactive, or that the line's own CC1 / project overrules
 * (gl/dimensions/costCentrePick). Every route that can drop a pick returns the
 * sentences as `warnings`; every screen that calls one passes the response
 * here. Without it the document posts and nobody learns its cost centre is
 * missing from the reports.
 *
 * The same channel as the late-claim notice (the toast), as a warning.
 */
import { notify } from '@/utils/toast';

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string' && w !== '') : []);

/**
 * Every posting warning in an API response body: `data.warnings`,
 * `data.claim.warnings` (expense claims) or `data.results[].warnings` (bulk
 * actions), in that order, without repeats.
 */
export function postingWarningsIn(body: unknown): string[] {
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== 'object') return [];
  const results = Array.isArray(data.results) ? data.results as Array<Record<string, unknown> | null> : [];
  return [...new Set([
    ...strings(data.warnings),
    ...strings((data.claim as Record<string, unknown> | undefined)?.warnings),
    ...results.flatMap((r) => strings(r?.warnings)),
  ])];
}

const SHOWN = 3;

/** One sentence block for a notice: the first three warnings, and how many more there are. */
export function postingWarningsMessage(warnings: readonly string[]): string {
  const more = warnings.length - SHOWN;
  return warnings.slice(0, SHOWN).join(' ') + (more > 0 ? ` (+${more} more)` : '');
}

/** Show the notice for a response, if it carries posting warnings. Returns how many it found. */
export function notifyPostingWarnings(body: unknown): number {
  const found = postingWarningsIn(body);
  if (found.length > 0) {
    notify.warning(found.length === 1 ? 'Posted — 1 cost centre was not applied' : `Posted — ${found.length} cost centres were not applied`,
      postingWarningsMessage(found));
  }
  return found.length;
}
