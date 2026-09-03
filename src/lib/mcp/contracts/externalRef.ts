/**
 * The source-system identity carried by every document IsaFlow creates.
 *
 * On the Sage migration, invoice INV0000133 became IsaFlow INV0000137 because
 * IsaFlow assigns its own numbers and refuses a supplied one. Both numbers exist,
 * they refer to the same sale, and nothing in either system records that. The
 * crosswalk is not merely lost — it cannot be rebuilt, because the only shared
 * key was the number that got overwritten. Every future reconciliation against
 * the legacy books mismatches, permanently, on a set of records nobody can
 * repair by hand.
 *
 * So: keep IsaFlow's numbering (it is what makes the sequence auditable), and
 * store the origin alongside it. Three fields, stored, INDEXED, and accepted as
 * a filter — a reference you cannot query by is a comment.
 */

export interface ExternalRef {
  /**
   * The source system's own identifier for this record — its primary key, not
   * its human-facing number. Survives a renumbering in the source system.
   */
  external_ref?: string;
  /**
   * The document number as the source system displayed it: `INV0000133`. This is
   * what a person holding the old paperwork will search for.
   */
  external_document_number?: string;
  /** Which system it came from: `sage`, `xero`, `quickbooks`, `csv_import`. */
  external_system?: string;
}

/**
 * JSON Schema fragment for the three arguments. Spread into the `properties` of
 * every document-creating tool: invoices, credit notes, supplier invoices,
 * journals, bank transactions, customers, suppliers.
 */
export const EXTERNAL_REF_ARG_SCHEMA = {
  external_ref: {
    type: 'string',
    maxLength: 128,
    description:
      "The source system's own id for this record. Stored and filterable, so a migrated document can always be traced back. Does not affect IsaFlow's own numbering.",
  },
  external_document_number: {
    type: 'string',
    maxLength: 64,
    description:
      'The document number as the source system showed it (e.g. INV0000133). IsaFlow still assigns its own number; this preserves the original for reconciliation.',
  },
  external_system: {
    type: 'string',
    maxLength: 32,
    description: 'Which system the record came from: sage, xero, quickbooks, csv_import.',
  },
} as const;

/** Filter arguments the matching LIST tools accept. Same three names. */
export const EXTERNAL_REF_FILTER_SCHEMA = EXTERNAL_REF_ARG_SCHEMA;

const MAX_REF = 128;
const MAX_DOC_NUMBER = 64;
const MAX_SYSTEM = 32;

/**
 * Validates and normalises the three fields. Returns an error MESSAGE (not a
 * thrown error) so a tool can return it as a pre-write `toolError` with the
 * offending argument named.
 */
export function parseExternalRef(
  args: Record<string, unknown>,
): { ok: true; value: ExternalRef } | { ok: false; error: string } {
  const out: ExternalRef = {};
  const limits: Array<[keyof ExternalRef, number]> = [
    ['external_ref', MAX_REF],
    ['external_document_number', MAX_DOC_NUMBER],
    ['external_system', MAX_SYSTEM],
  ];
  for (const [key, max] of limits) {
    const raw = args[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') return { ok: false, error: `invalid ${key}: expected a string` };
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.length > max) {
      return { ok: false, error: `invalid ${key}: longer than ${max} characters` };
    }
    out[key] = trimmed;
  }
  return { ok: true, value: out };
}
