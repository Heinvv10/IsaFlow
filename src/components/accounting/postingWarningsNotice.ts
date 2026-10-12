/**
 * Telling the person that a posting went through but part of what they asked
 * for was NOT applied: a cost centre picked on a bill, a claim or a recurring
 * template that is inactive, or that the line's own CC1 / project overrules
 * (gl/dimensions/costCentrePick). Every route that can drop a pick returns the
 * sentences as `warnings`; every screen that calls one passes the response
 * here. Without it the document posts and nobody learns its cost centre is
 * missing from the reports.
 *
 * The same channel as the late-claim notice (the toast), as a warning. The
 * toast clips its second line to one row, so the TITLE — which wraps — says
 * which centre and why ("Posted — cost centre OLD not applied (inactive)") and
 * the second line only what fits: the line it was on, or how many more.
 *
 * COUNTED PER DOCUMENT. Two bills that each drop the same centre are two
 * dropped picks, not one: a sentence is merged only with its own repeat inside
 * one document.
 */
import { notify } from '@/utils/toast';
import { parsePickDropSentence, pickDropFact } from '@/lib/costCentrePickWording';

/**
 * The part of a posting route's response this notice reads. `id` is there so a
 * whole document (a claim) can be passed as it is; nothing here reads it.
 */
export interface PostingWarningsBody {
  data?: {
    warnings?: string[];
    claim?: { id?: string; warnings?: string[] } | null;
    results?: Array<{ warnings?: string[] } | null>;
    /** An auto-post sweep's answer: one entry per bank transaction that posted without a pick (bank import, smart-categorize). */
    autoPost?: { warnings?: Array<{ warnings?: string[] } | null> } | null;
  } | null;
}

const strings = (v: unknown): string[] =>
  [...new Set(Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string' && w !== '') : [])];

/**
 * The warnings of each document in an API response body that has any:
 * `data.warnings`, `data.claim.warnings` (expense claims), and one entry per
 * `data.results[]` item (bulk actions) and per `data.autoPost.warnings[]`
 * item (an auto-post sweep: one per bank transaction).
 */
export function postingWarningsByDocument(body: PostingWarningsBody | null | undefined): string[][] {
  // Read as untyped: it is a server's answer, and a wrong shape must show nothing rather than throw.
  const data = (body as { data?: Record<string, unknown> } | null | undefined)?.data;
  if (!data || typeof data !== 'object') return [];
  const results = Array.isArray(data.results) ? data.results as Array<Record<string, unknown> | null> : [];
  const swept = (data.autoPost as { warnings?: unknown } | null | undefined)?.warnings;
  const sweptTxs = Array.isArray(swept) ? swept as Array<Record<string, unknown> | null> : [];
  return [
    strings(data.warnings),
    strings((data.claim as Record<string, unknown> | undefined)?.warnings),
    ...results.map((r) => strings(r?.warnings)),
    ...sweptTxs.map((t) => strings(t?.warnings)),
  ].filter((w) => w.length > 0);
}

/** Every posting warning in a response, document by document — the full sentences. */
export function postingWarningsIn(body: PostingWarningsBody | null | undefined): string[] {
  return postingWarningsByDocument(body).flat();
}

/** The notice for a response's warnings: a title that says which centre and why, and a second line that fits. */
export function postingWarningsNotice(byDocument: readonly string[][]): { title: string; message: string } {
  const all = byDocument.flat();
  const first = all[0] ?? '';
  const drop = parsePickDropSentence(first);
  // A sentence this screen does not know still reaches the person whole: the title wraps.
  const title = `Posted — ${drop ? pickDropFact(drop) : first.replace(/^Line \d+: /, '')}`;
  if (all.length === 1) return { title, message: drop ? `Line ${drop.line} posted without it.` : '' };
  const documents = byDocument.length > 1 ? `, in ${byDocument.length} documents` : '';
  return { title, message: `+${all.length - 1} more not applied${documents}.` };
}

/** Show the notice for a response, if it carries posting warnings. Returns how many dropped picks it found. */
export function notifyPostingWarnings(body: PostingWarningsBody | null | undefined): number {
  const byDocument = postingWarningsByDocument(body);
  const count = byDocument.reduce((n, w) => n + w.length, 0);
  if (count > 0) {
    const { title, message } = postingWarningsNotice(byDocument);
    notify.warning(title, message || undefined);
  }
  return count;
}
