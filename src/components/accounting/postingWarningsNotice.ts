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
 * one document. A bulk action names the bills it happened on in the second line.
 */
import { notify } from '@/utils/toast';
import { parsePickDropSentence, pickDropFact } from '@/lib/costCentrePickWording';
import { NOTICE_LINE_FITS, listNames } from '@/components/accounting/noticeLine';

/**
 * The part of a posting route's response this notice reads. `id` is there so a
 * whole document (a claim) can be passed as it is; nothing here reads it.
 */
export interface PostingWarningsBody {
  data?: {
    warnings?: string[];
    claim?: { id?: string; warnings?: string[] } | null;
    results?: Array<{ warnings?: string[]; invoiceNumber?: string | null } | null>;
  } | null;
}

const strings = (v: unknown): string[] =>
  [...new Set(Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string' && w !== '') : [])];

/** One document's warnings, and the number it is known by when the response carries it (bulk actions). */
export interface DocumentWarnings { name?: string; warnings: string[] }

/**
 * The warnings of each document in an API response body that has any:
 * `data.warnings`, `data.claim.warnings` (expense claims), and one entry per
 * `data.results[]` item (bulk actions, which also carry its `invoiceNumber`).
 */
export function postingWarningsDocuments(body: PostingWarningsBody | null | undefined): DocumentWarnings[] {
  // Read as untyped: it is a server's answer, and a wrong shape must show nothing rather than throw.
  const data = (body as { data?: Record<string, unknown> } | null | undefined)?.data;
  if (!data || typeof data !== 'object') return [];
  const results = Array.isArray(data.results) ? data.results as Array<Record<string, unknown> | null> : [];
  const name = (r: Record<string, unknown> | null) =>
    typeof r?.invoiceNumber === 'string' && r.invoiceNumber !== '' ? r.invoiceNumber : undefined;
  return [
    { warnings: strings(data.warnings) },
    { warnings: strings((data.claim as Record<string, unknown> | undefined)?.warnings) },
    ...results.map((r) => ({ name: name(r), warnings: strings(r?.warnings) })),
  ].filter((d) => d.warnings.length > 0);
}

/** The warnings of each document in a response body, without the numbers. */
export function postingWarningsByDocument(body: PostingWarningsBody | null | undefined): string[][] {
  return postingWarningsDocuments(body).map((d) => d.warnings);
}

/** Every posting warning in a response, document by document — the full sentences. */
export function postingWarningsIn(body: PostingWarningsBody | null | undefined): string[] {
  return postingWarningsByDocument(body).flat();
}

/**
 * The notice for a response's warnings: a title that says which centre and why,
 * and a second line that fits. `names` are the documents' numbers, one per
 * entry of `byDocument`, when the response carried them.
 */
export function postingWarningsNotice(
  byDocument: readonly string[][], names: ReadonlyArray<string | undefined> = [],
): { title: string; message: string } {
  const all = byDocument.flat();
  const first = all[0] ?? '';
  const drop = parsePickDropSentence(first);
  // A sentence this screen does not know still reaches the person whole: the title wraps.
  const title = `Posted — ${drop ? pickDropFact(drop) : first.replace(/^Line \d+: /, '')}`;
  // A bulk run names the bill when it fits beside the line; one bill's other warnings read as "+k more".
  const bill = byDocument.length === 1 ? names[0] : undefined;
  if (all.length === 1) {
    const plain = drop ? `Line ${drop.line} posted without it.` : '';
    const named = bill && drop ? `${bill}: line ${drop.line} posted without it.` : '';
    return { title, message: named !== '' && named.length <= NOTICE_LINE_FITS ? named : plain };
  }
  if (byDocument.length > 1) {
    // Line 2 counts and lists the same thing: the bills (the title says what was not applied).
    const bills = `${byDocument.length} bills`;
    return { title, message: listNames(`${bills}: `, byDocument.map((_, i) => names[i]), bills) };
  }
  const more = `+${all.length - 1} more not applied.`;
  const namedMore = bill ? `${bill}: ${more}` : '';
  return { title, message: namedMore !== '' && namedMore.length <= NOTICE_LINE_FITS ? namedMore : more };
}

/** Show the notice for a response, if it carries posting warnings. Returns how many dropped picks it found. */
export function notifyPostingWarnings(body: PostingWarningsBody | null | undefined): number {
  const documents = postingWarningsDocuments(body);
  const byDocument = documents.map((d) => d.warnings);
  const count = byDocument.reduce((n, w) => n + w.length, 0);
  if (count > 0) {
    const { title, message } = postingWarningsNotice(byDocument, documents.map((d) => d.name));
    notify.warning(title, message || undefined);
  }
  return count;
}
