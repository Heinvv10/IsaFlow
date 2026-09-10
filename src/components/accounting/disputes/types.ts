/**
 * Shared row shape for the disputes queue page and its modal.
 */

export type DisputeStatus = 'open' | 'resolved' | 'withdrawn' | 'rejected';

export interface DisputeRow {
  id: string;
  customerInvoiceId: string;
  customerInvoiceLineId: string | null;
  reason: string;
  raisedBy: string;
  raisedAt: string;
  status: DisputeStatus;
  disputedAmount: number;
  resolvedAt: string | null;
  resolutionMode: string | null;
  creditNoteId: string | null;
  invoiceNumber?: string | null;
  clientName?: string | null;
}
