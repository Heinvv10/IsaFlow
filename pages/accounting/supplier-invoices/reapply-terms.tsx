/**
 * Re-apply payment terms (payment-terms programme PR 3): preview which open bills' due dates their suppliers' terms
 * would move, tick, confirm. The screen is shared with the customer-invoice twin (components/accounting/terms).
 */
import { SupplierSelect } from '@/components/accounting/supplier-invoices/SupplierSelect';
import { ReapplyTermsView } from '@/components/accounting/terms/ReapplyTermsView';
import type { ReapplyTermsConfig, TermsPreview } from '@/components/accounting/terms/reapplyTermsView.types';
import type { ReapplyPreview } from '@/modules/accounting/services/ap/reapplyTerms';

const adapt = (data: unknown): TermsPreview => {
  const p = data as ReapplyPreview;
  return {
    unchanged: p.unchanged, truncated: p.truncated,
    rows: p.rows.map((r) => ({ ...r, partyName: r.supplierName })),
    skipped: p.skippedSuppliers.map((s) => ({ partyId: s.supplierId, partyName: s.supplierName, count: s.openBills, balance: s.balance })),
  };
};

const CONFIG: ReapplyTermsConfig = {
  party: 'Supplier', noun: 'bill', apiPath: '/api/accounting/supplier-invoices-reapply-terms', filterParam: 'supplierId',
  backHref: '/accounting/supplier-invoices', backLabel: 'Back to supplier invoices',
  documentHref: (id) => `/accounting/supplier-invoices/${id}`, adapt,
};

export default function ReapplyTermsPage() {
  return <ReapplyTermsView config={CONFIG} filter={(value, onChange) => <SupplierSelect value={value} onChange={(id) => onChange(id)} placeholder="All suppliers" />} />;
}
