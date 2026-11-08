/**
 * Where a document's due date came from (migration 962; payment-terms programme PR 2). Re-apply terms (PR 3)
 * overwrites `terms` and `legacy` dates on open documents and lists `manual` and `document` ones unticked.
 *   terms     the contact's terms, else the company default, gave it;
 *   manual    a person or API caller chose it (a typed date that differs from the terms', a bill's own "net30", an edit
 *             after approval). A given date equal to the terms' date is recorded as `terms`, whoever gave it: the pages
 *             prefill it, so the server cannot tell a prefill from a choice (named limit; Re-apply previews before it writes);
 *   document  the source document gave it (a scanned bill's printed due date or terms, an imported row's date);
 *   legacy    written before 962, or by code that names no source (the column default).
 */
/** At or under this much owing a document owes nothing: Re-apply skips it and the due-date edit refuses it (AP and AR).
 * Here, not in reapplyTermsShared, so the browser editor can share it (this module is client-safe). */
export const NOTHING_OWING_EPS = 0.005;

export const DUE_DATE_SOURCES = ['terms', 'manual', 'document', 'legacy'] as const;
export type DueDateSource = (typeof DUE_DATE_SOURCES)[number];

export const DUE_DATE_SOURCE_LABELS: Record<DueDateSource, string> = {
  terms: 'Payment terms',
  manual: 'Set by hand',
  document: 'From the document',
  legacy: 'Before sources were recorded',
};

export function isDueDateSource(value: unknown): value is DueDateSource {
  return typeof value === 'string' && (DUE_DATE_SOURCES as readonly string[]).includes(value);
}

/**
 * The source of a due date a creator stores. `given` is a date the caller or document supplied (null when none);
 * `termsDate` is what the contact's terms (or the company default) give. No given date: the terms gave it. A given date
 * equal to the terms' date is `terms` too: the capture pages prefill the terms' date and send it back, and a date the
 * terms would give anyway should move when the terms do. Any other given date is `givenAs`.
 */
export function dueDateSourceOf(
  given: string | null | undefined, termsDate: string | null, givenAs: 'manual' | 'document',
): DueDateSource {
  if (!given) return 'terms';
  return given === termsDate ? 'terms' : givenAs;
}
