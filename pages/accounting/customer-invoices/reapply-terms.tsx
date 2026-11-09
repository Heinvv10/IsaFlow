/**
 * Re-apply payment terms to open customer invoices (payment-terms programme, AR parity with
 * supplier-invoices/reapply-terms): preview which invoices' due dates their customers' terms would move, tick, confirm.
 * The screen is shared with the supplier-bill twin (components/accounting/terms).
 */
import { useState } from 'react';
import { CustomerTypeahead } from '@/components/accounting/customer-invoices/CustomerTypeahead';
import { ReapplyTermsView } from '@/components/accounting/terms/ReapplyTermsView';
import type { ReapplyTermsConfig, TermsPreview } from '@/components/accounting/terms/reapplyTermsView.types';
import type { ArReapplyPreview } from '@/modules/accounting/services/ar/reapplyTerms';

const adapt = (data: unknown): TermsPreview => {
  const p = data as ArReapplyPreview;
  return {
    unchanged: p.unchanged, truncated: p.truncated,
    rows: p.rows.map((r) => ({ ...r, partyName: r.customerName })),
    skipped: p.skippedCustomers.map((c) => ({ partyId: c.customerId, partyName: c.customerName, count: c.openInvoices, balance: c.balance })),
  };
};

const CONFIG: ReapplyTermsConfig = {
  party: 'Customer', noun: 'invoice', apiPath: '/api/accounting/customer-invoices-reapply-terms', filterParam: 'customerId',
  backHref: '/accounting/customer-invoices', backLabel: 'Back to customer invoices',
  documentHref: (id) => `/accounting/customer-invoices/${id}`, adapt,
};

const INPUT = 'px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm';

/** The typeahead holds the name it shows; the screen holds the id. */
function CustomerFilter({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [label, setLabel] = useState('');
  return (
    <CustomerTypeahead
      selectedId={value} selectedLabel={label} inputClassName={INPUT}
      onSelect={(id, name) => { setLabel(name); onChange(id); }}
      onClear={() => { setLabel(''); onChange(''); }}
    />
  );
}

export default function ReapplyCustomerTermsPage() {
  return <ReapplyTermsView config={CONFIG} filter={(value, onChange) => <CustomerFilter value={value} onChange={onChange} />} />;
}
