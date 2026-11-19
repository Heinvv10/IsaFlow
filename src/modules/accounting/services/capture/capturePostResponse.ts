/**
 * The body POST /api/accounting/capture/[id]/post answers with (moved out of the route to keep it
 * under 300 lines, #1656). A bill the gate would have approved but the person may not approve
 * (`approveWithheld`) is answered as routed for review, with a warning that says why: never as
 * gateOutcome 'auto_publish' beside a draft.
 */
import type { PublishedDecision, CapturePostFollowUps } from './capturePostFollowUps';
import { SUPPLIER_INVOICE_APPROVE_REFUSED } from '../ap/billApprovePermission';

export const APPROVE_WITHHELD_WARNING = `Left as a draft for review: ${SUPPLIER_INVOICE_APPROVE_REFUSED}`;

export interface CapturePostBodyInput {
  invoice: { id?: unknown; invoice_number?: unknown };
  status: unknown;
  supplierMatch: { supplierName: string; confidence: number };
  pipelineConfidence: number;
  approvalRoute: string;
  warnings: string[];
  decision: PublishedDecision;
  approveWithheld: boolean;
  followUps: CapturePostFollowUps;
  approvalRequired: boolean;
  approvalRequest: unknown;
}

export function capturePostBody(i: CapturePostBodyInput): Record<string, unknown> {
  const common = {
    invoice: { id: i.invoice.id, invoiceNumber: i.invoice.invoice_number, status: i.status },
    supplierMatch: { name: i.supplierMatch.supplierName, confidence: i.supplierMatch.confidence },
    pipelineConfidence: i.pipelineConfidence,
    approvalRoute: i.approvalRoute,
    warnings: i.approveWithheld ? [...i.warnings, APPROVE_WITHHELD_WARNING] : i.warnings,
  };
  const tail = {
    threeWayMatch: i.followUps.threeWayMatch,
    provisionalAttach: i.followUps.provisionalAttach, approvalRequired: i.approvalRequired, approvalRequest: i.approvalRequest,
  };
  if (i.decision.outcome === 'route_review' || i.approveWithheld) {
    return {
      ...common,
      reason: i.approveWithheld ? 'held for review: no permission to approve supplier invoices' : 'routed for review',
      reasons: i.decision.outcome === 'route_review' ? i.decision.reasons : ['no_approve_permission'],
      ...tail,
    };
  }
  return { ...common, gateOutcome: i.decision.outcome, gateReason: i.decision.reason, ...tail };
}
