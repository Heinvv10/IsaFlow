/**
 * Per-line VAT refusal codes an MCP tool may show an agent verbatim (spread into `refusalCodes.ts`, which is over the
 * 300-line cap). Append-only: each per-line VAT PR adds one line for its own code.
 */
export const VAT_LINE_REFUSAL_CODES = [
  // ar/creditNoteTypedSplit: a note against a typed invoice whose VAT is not the invoice's remaining VAT in proportion
  // (or that credits more than is left). Names only the note's and the invoice's own figures; raised before any write.
  'CREDIT_NOTE_VAT_SPLIT_REFUSED',
] as const;
