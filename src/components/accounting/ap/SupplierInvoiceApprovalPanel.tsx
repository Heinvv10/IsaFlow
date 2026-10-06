/**
 * R-035 PR2: the approval panel on the supplier-invoice page — the generic
 * DocumentApprovalPanel (PR3) bound to a bill.
 */
import type { DocumentApprovalState } from '@/modules/accounting/types/approval.types';
import { DocumentApprovalPanel } from '@/components/accounting/approvals/DocumentApprovalPanel';

interface Props {
  invoiceId: string;
  approval: DocumentApprovalState | null | undefined;
  onChanged: () => Promise<void> | void;
}

export function SupplierInvoiceApprovalPanel({ invoiceId, approval, onChanged }: Props) {
  return <DocumentApprovalPanel documentType="supplier_invoice" documentId={invoiceId} noun="bill" approval={approval} onChanged={onChanged} />;
}
