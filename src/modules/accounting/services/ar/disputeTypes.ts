/**
 * Customer invoice dispute types and row mapping — shared by disputeService
 * and disputeResolution so neither file has to import the other.
 */

import { type DbRow } from '@/lib/neon';

export type DisputeStatus = 'open' | 'resolved' | 'withdrawn' | 'rejected';
export type DisputeResolutionMode =
  | 'resolve_with_credit'
  | 'resolve_no_credit'
  | 'rejected'
  | 'withdrawn';

export const ELIGIBLE_STATUSES = ['sent', 'approved', 'partially_paid', 'overdue'] as const;

export interface Dispute {
  id: string;
  companyId: string;
  customerInvoiceId: string;
  customerInvoiceLineId: string | null;
  reason: string;
  raisedBy: string;
  raisedAt: string;
  status: DisputeStatus;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  resolutionMode: DisputeResolutionMode | null;
  creditNoteId: string | null;
  disputedAmount: number;
  sourceDocumentId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface RaiseDisputeInput {
  customerInvoiceId: string;
  customerInvoiceLineId?: string | null;
  reason: string;
  disputedAmount: number;
  raisedBy: string;
  sourceDocumentId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ListDisputesFilters {
  status?: DisputeStatus;
  customerInvoiceId?: string;
  limit?: number;
  offset?: number;
}

export interface ResolveDisputeInput {
  mode: 'resolve_with_credit' | 'resolve_no_credit' | 'rejected';
  note?: string;
  creditDate?: string;
}

export function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function mapRow(r: DbRow): Dispute {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    customerInvoiceId: String(r.customer_invoice_id),
    customerInvoiceLineId:
      r.customer_invoice_line_id != null ? String(r.customer_invoice_line_id) : null,
    reason: String(r.reason),
    raisedBy: String(r.raised_by),
    raisedAt: toIsoOrNull(r.raised_at) ?? '',
    status: String(r.status) as DisputeStatus,
    resolvedAt: toIsoOrNull(r.resolved_at),
    resolvedBy: r.resolved_by != null ? String(r.resolved_by) : null,
    resolutionNote: r.resolution_note != null ? String(r.resolution_note) : null,
    resolutionMode:
      r.resolution_mode != null ? (String(r.resolution_mode) as DisputeResolutionMode) : null,
    creditNoteId: r.credit_note_id != null ? String(r.credit_note_id) : null,
    disputedAmount: Number(r.disputed_amount),
    sourceDocumentId: r.source_document_id != null ? String(r.source_document_id) : null,
    ipAddress: r.ip_address != null ? String(r.ip_address) : null,
    userAgent: r.user_agent != null ? String(r.user_agent) : null,
  };
}

export interface ListDisputesResult {
  disputes: Dispute[];
  /** Every dispute matching the filters, not the size of this page. */
  total: number;
  /** Open disputes for this company (and invoice filter), ignoring `status`. */
  openTotal: number;
  /** Sum of disputed_amount over those open disputes. */
  openDisputedAmount: number;
}
