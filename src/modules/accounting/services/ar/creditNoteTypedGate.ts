/**
 * Which applications the typed-invoice apply gate judges (ar/creditNoteTypedApplication): a CUSTOMER note's on any
 * invoice but the one it is linked to (its application there counts by its link, and its own approve held it to what
 * was left). Pure: the dry run's simulation and the live planner share it.
 */
export interface GateNote { id: string; number: string; type: string; customerInvoiceId: string | null }

/** Whether the gate judges `note` on `invoiceId`. */
export const gated = (note: Pick<GateNote, 'type' | 'customerInvoiceId'>, invoiceId: string): boolean =>
  note.type === 'customer' && note.customerInvoiceId?.toLowerCase() !== invoiceId.toLowerCase();

/** The note row's fields the gate reads. */
export const gateNote = (row: Record<string, unknown>): GateNote => ({
  id: String(row.id),
  number: String(row.credit_note_number ?? ''),
  type: String(row.type ?? ''),
  customerInvoiceId: row.customer_invoice_id ? String(row.customer_invoice_id) : null,
});
