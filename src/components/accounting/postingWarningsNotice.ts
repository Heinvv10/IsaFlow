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
import { warningMessages } from '@/lib/warningMessages';
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
    /** An auto-post sweep's answer: one entry per bank transaction that posted without a pick (bank import, smart-categorize). */
    autoPost?: { warnings?: Array<{ warnings?: string[]; label?: string } | null> } | null;
  } | null;
}

const strings = warningMessages; // the one coercion, shared with the bulk import: a wrong shape is read, not lost

/**
 * One document's warnings, and what it is known by when the response carries it: the invoice number
 * of a bulk action's bill (`name`), or the bank line of an auto-post sweep (`label`, '' when it has none).
 */
export interface DocumentWarnings { name?: string; label?: string; warnings: string[] }

/**
 * The documents of an API response body that carry warnings: `data.warnings`,
 * `data.claim.warnings` (expense claims), one per `data.results[]` item (bulk
 * actions, which also carry its `invoiceNumber`) and one per
 * `data.autoPost.warnings[]` item (an auto-post sweep: one per bank transaction,
 * with its `label`).
 */
export function postingWarningsDocuments(body: PostingWarningsBody | null | undefined): DocumentWarnings[] {
  // Read as untyped: it is a server's answer, and a wrong shape must show nothing rather than throw.
  const data = (body as { data?: Record<string, unknown> } | null | undefined)?.data;
  if (!data || typeof data !== 'object') return [];
  const results = Array.isArray(data.results) ? data.results as Array<Record<string, unknown> | null> : [];
  const swept = (data.autoPost as { warnings?: unknown } | null | undefined)?.warnings;
  const sweptTxs = Array.isArray(swept) ? swept as Array<Record<string, unknown> | null> : [];
  const name = (r: Record<string, unknown> | null) =>
    typeof r?.invoiceNumber === 'string' && r.invoiceNumber !== '' ? r.invoiceNumber : undefined;
  return [
    { warnings: strings(data.warnings) },
    { warnings: strings((data.claim as Record<string, unknown> | undefined)?.warnings) },
    ...results.map((r) => ({ name: name(r), warnings: strings(r?.warnings) })),
    // label '' marks a sweep line that has none: it is still a bank line (line 2 points at the list)
    ...sweptTxs.map((t) => ({ warnings: strings(t?.warnings), label: typeof t?.label === 'string' ? t.label : '' })),
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

/** What one warning sentence says, short: "cost centre OLD not applied (inactive)". */
export function postingWarningFact(sentence: string): string {
  const drop = parsePickDropSentence(sentence);
  return drop ? pickDropFact(drop) : sentence.replace(/^Line \d+: /, '');
}

/**
 * The notice for a response's warnings: a title that says which centre and why,
 * and a second line that fits. `names` are the documents' numbers, one per
 * entry of `byDocument`, when the response carried them (bulk bills). `labels`
 * are the bank lines of an auto-post sweep's documents ('' for a line without
 * one; undefined for a document that is not a bank line): the first goes in the
 * title, which wraps, because the toast clips its second line. Bank lines are
 * LISTED by the screen that imported them (BulkImportFileRow), so their line 2
 * is only a pointer — short and without digits that could overflow the one row
 * — and counts every warning, not every bank line: one line can carry several.
 */
export function postingWarningsNotice(
  byDocument: readonly string[][], names: ReadonlyArray<string | undefined> = [],
  labels: ReadonlyArray<string | undefined> = [],
): { title: string; message: string } {
  const all = byDocument.flat();
  const first = all[0] ?? '';
  const drop = parsePickDropSentence(first);
  const firstLabel = labels[0]; // undefined: not a bank line; '': a bank line without a label
  // A sentence this screen does not know still reaches the person whole: the title wraps.
  const title = `Posted — ${drop ? pickDropFact(drop) : first.replace(/^Line \d+: /, '')}${firstLabel ? `, bank line ${firstLabel}` : ''}`;
  // An auto-post sweep's bank lines: a pointer to the list, whatever the label (a bill's wording below is not theirs).
  if (firstLabel !== undefined) {
    return { title, message: all.length > 2 ? `+${all.length - 1} more warnings — listed below` : all.length === 2 ? '+1 more warning — listed below' : 'See the list below.' };
  }
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
    const { title, message } = postingWarningsNotice(byDocument, documents.map((d) => d.name), documents.map((d) => d.label));
    notify.warning(title, message || undefined);
  }
  return count;
}
