/**
 * Per-line VAT refusal codes an MCP tool may show an agent verbatim (spread into `refusalCodes.ts`, which is over the
 * 300-line cap). Append-only: each per-line VAT PR adds one line for its own code.
 */
export const VAT_LINE_REFUSAL_CODES = [
  // ar/creditNoteTypedSplit: a note against a typed invoice whose VAT is not the invoice's remaining VAT in proportion
  // (or that credits more than is left). Names only the note's and the invoice's own figures; raised before any write.
  'CREDIT_NOTE_VAT_SPLIT_REFUSED',
  // ar/invoiceLineVatTypes: a customer invoice line's VAT type that is not one a line takes, a legacy tax_rate that is neither
  // the standard rate on the invoice date nor 0, tax_rate with a line vat_type, a line rate not its type's, a date with no
  // rate. Names only the caller's own line index, type and rate; raised before any write.
  'INVOICE_LINE_VAT_REFUSED',
  // ar/invoiceLineVatTypes: VAT asked of a company not registered for VAT (a standard line, a rate above 0). Fixed wording
  // naming the caller's own line index and rate; raised before any write.
  'INVOICE_VAT_NOT_REGISTERED',
] as const;
