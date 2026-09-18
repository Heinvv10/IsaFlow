/**
 * The prose and the input schema for `aged_debtors` / `aged_creditors`.
 *
 * Split out of reportsAging.ts for the 300-line cap in CLAUDE.md. It is a clean
 * seam: every string here is read by an AGENT rather than by code, and the two
 * tools share all of it except the entity noun. Keeping the descriptions beside
 * the query logic is what pushed the file over, and a description that drifts
 * from the tool is the one defect this file can cause — so it says what the
 * tool does and nothing about how.
 */

export const AS_AT_CAVEAT =
  'A PAST as_at is reconstructed by unwinding settlement dated since it: payment allocations, credit notes and write-offs. '
  + 'Settlement that left no dated trail — a receipt captured with no allocation row, a migrated balance, a cancelled payment — cannot be unwound, so for those invoices an earlier date reproduces the CURRENT figure rather than what was actually owed then. It will never report an invoice as outstanding once it has been settled.';

export const NETTING_NOTE =
  'Each entity row carries `unapplied` (NEGATIVE — on-account cash plus the face value its live credit notes have not consumed, as at the same date) and `net` = total + unapplied. '
  + 'The BUCKETS stay gross, so they still add up to `gross_total`; the headline `total` is the NET, which is what a payment run or a collections call acts on. '
  + 'An entity in credit with no open document still gets a row, with zero buckets and a negative net. '
  + 'The two figures are named separately: the envelope\'s figureBasis covers the NET total and rows, and gross_figure_basis covers the buckets and gross_total. '
  + 'reconcile_subledger and the REST aging endpoints still report the GROSS figure, so compare like with like.';

export const TOTALS_NOTE =
  'total is the NET over EVERY entity and gross_total is the same figure before credit is netted; buckets are gross and over every entity, not just this page — rowsTotal says how many entities there are and truncated says whether you are seeing them all. '
  + 'entity_id drills into one customer or supplier and returns its INVOICES instead of the bucket summary. '
  + 'agedFromInvoiceDate counts invoices with no due date: they ARE in the buckets, aged from their invoice date, so their age is derived rather than known. '
  + 'detail "summary" returns the totals with no rows.';

export function schemaFor(entityLabel: string) {
  return {
    type: 'object' as const,
    properties: {
      as_at: { type: 'string', format: 'date', description: 'YYYY-MM-DD; defaults to today' },
      entity_id: {
        type: 'string',
        description: `Drill into one ${entityLabel} and return its invoices instead of the bucket summary.`,
      },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Entities per page. Default 200.' },
      cursor: { type: 'string', description: 'next_cursor from the previous page.' },
    },
    additionalProperties: false as const,
  };
}

