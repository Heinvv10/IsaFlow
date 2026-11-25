/**
 * The intercompany routes of the route registry (P1), kept beside `apiRoutes.ts` so the registry stays under the
 * file-size limit; `StaticRoutes` and `DynamicRoutes` there extend these. Same rules as the registry: one type per
 * URL, taken from the service, `{}` binds one segment. Every import is `import type`.
 */
import type { AcceptResult, InboxDetail, InboxPage } from '@/modules/accounting/services/intercompany/inboxTypes';
import type { ConnectionView, GroupCandidate, SideOptions } from '@/modules/accounting/services/intercompany/connectionTypes';
import type { PairingResult, PairingView } from '@/modules/accounting/services/intercompany/pairingTypes';
import type { AllocationDetail, AllocationPage } from '@/modules/accounting/services/intercompany/allocationInboxTypes';
import type { AcceptAllocationOutcome } from '@/modules/accounting/services/intercompany/allocationClearTypes';
import type { LoanClearingPreview, LoanClearResult } from '@/modules/accounting/services/intercompany/payerLoanClearTypes';
import type { ReconConnection, ReconReport } from '@/modules/accounting/services/intercompany/loanReconTypes';
import type { AcceptPaymentOutcome, PaymentDetail, PaymentPage, PaymentState, UnsentPage } from '@/modules/accounting/services/intercompany/paymentInboxTypes';

export interface IntercompanyStaticRoutes {
  // GET the list (`items`), POST the new connection: the list and the item of one resource, disjoint on `items`.
  '/api/accounting/intercompany/connections': { items: ConnectionView[]; count: number } | ConnectionView;
  '/api/accounting/intercompany/group-candidates': { items: GroupCandidate[]; count: number };
  '/api/accounting/intercompany/side-options': SideOptions;
  // P2: the messages other companies sent this one, and the count behind the Bills tab badge.
  '/api/accounting/intercompany/inbox': InboxPage;
  '/api/accounting/intercompany/inbox-count': { openCount: number; enabled: boolean };
  // P4-C: the payments a payer in the group applied to bills linked to this company's invoices (read only).
  '/api/accounting/intercompany/allocations': AllocationPage;
  // P4-E: GET the bill's "Clear against the intercompany loan" preview (?billId=), POST the clearing (one contra settlement).
  '/api/accounting/intercompany/loan-clearings': LoanClearingPreview | LoanClearResult;
  // P5: the connections the loan reconciliation can open (read only).
  '/api/accounting/intercompany/loan-reconciliation': { connections: ReconConnection[] };
  // F: the payments a payer in the group made from its bank on bills linked to this company's invoices (cash mode), the payer's unsent list,
  // and a receipt's intercompany chip (?receiptId=)
  '/api/accounting/intercompany/payments': PaymentPage;
  '/api/accounting/intercompany/payments/unsent': UnsentPage;
  '/api/accounting/intercompany/payments/receipt-state': { messageId: string; state: PaymentState; status: string } | null;
}

export interface IntercompanyDynamicRoutes {
  // PUT (edit this company's side) and DELETE (revoke) both answer with the connection.
  '/api/accounting/intercompany/connections/{}': ConnectionView;
  // PUT the pair's agreement (mode, cut-over, interest): answers with the connection.
  '/api/accounting/intercompany/connections/{}/settings': ConnectionView;
  '/api/accounting/intercompany/inbox/{}': InboxDetail;
  '/api/accounting/intercompany/inbox/{}/accept': AcceptResult;
  '/api/accounting/intercompany/inbox/{}/reject': { id: string; status: string };
  '/api/accounting/intercompany/inbox/{}/dismiss': { id: string; status: string };
  '/api/accounting/intercompany/inbox/{}/restore': { id: string; status: string };
  '/api/accounting/intercompany/allocations/{}': AllocationDetail;
  '/api/accounting/intercompany/allocations/{}/reject': { id: string; status: string };
  '/api/accounting/intercompany/allocations/{}/dismiss': { id: string; status: string };
  '/api/accounting/intercompany/allocations/{}/restore': { id: string; status: string };
  // P4-D: clear an allocation (one contra settlement) or store why it was refused (`accepted: false`).
  '/api/accounting/intercompany/allocations/{}/accept': AcceptAllocationOutcome;
  // F: one payment message (its suggestions while open), the two accept outcomes, the discard of an F draft, and the other handlings
  '/api/accounting/intercompany/payments/{}': PaymentDetail;
  '/api/accounting/intercompany/payments/{}/accept': AcceptPaymentOutcome;
  '/api/accounting/intercompany/payments/{}/discard-draft': { messageId: string; status: 'pending'; paymentId: string };
  '/api/accounting/intercompany/payments/{}/reject': { id: string; status: string };
  '/api/accounting/intercompany/payments/{}/dismiss': { id: string; status: string };
  '/api/accounting/intercompany/payments/{}/restore': { id: string; status: string };
  // GET the pairing screen's data; POST records pairs (answers with the counts).
  '/api/accounting/intercompany/connections/{}/pairing': PairingView | PairingResult;
  // PUT confirms the partner's proposal, DELETE unlinks: both answer with the link's new status.
  '/api/accounting/intercompany/connections/{}/pairing/links/{}': { status: string };
  // P5: one connection's loan reconciliation as at today (?section=&limit=&offset=), read only.
  '/api/accounting/intercompany/loan-reconciliation/{}': ReconReport;
}
