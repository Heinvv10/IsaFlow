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

/**
 * The part of a posting route's response this notice reads. `id` is there so a
 * whole document (a claim) can be passed as it is; nothing here reads it.
 */
export interface PostingWarningsBody {
  data?: {
    warnings?: string[];
    claim?: { id?: string; warnings?: string[] } | null;
    results?: Array<{ warnings?: string[] } | null>;
  } | null;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string' && w !== '') : []);

/**
 * Every posting warning in an API response body: `data.warnings`,
 * `data.claim.warnings` (expense claims) or `data.results[].warnings` (bulk
 * actions), in that order, without repeats.
 */
export function postingWarningsIn(body: PostingWarningsBody | null | undefined): string[] {
  // Read as untyped: it is a server's answer, and a wrong shape must show nothing rather than throw.
  const data = (body as { data?: Record<string, unknown> } | null | undefined)?.data;
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
export function notifyPostingWarnings(body: PostingWarningsBody | null | undefined): number {
  const found = postingWarningsIn(body);
  if (found.length > 0) {
    notify.warning(found.length === 1 ? 'Posted — 1 cost centre was not applied' : `Posted — ${found.length} cost centres were not applied`,
      postingWarningsMessage(found));
  }
  return found.length;
}
