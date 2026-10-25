/** VAT201 detail view: the period's invoices behind the SARS totals (fields 13, 19, 20). */
import { TransactionTable, type VAT201Invoice } from './VAT201FormSections';
import type { Vat201SarsField } from '@/modules/accounting/services/reports/vat201SarsFields';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

interface Props {
  data: { sarsFields: Vat201SarsField[]; outputInvoices: VAT201Invoice[]; inputInvoices: VAT201Invoice[] };
}

export function VAT201DetailView({ data }: Props) {
  const amount = (field: string): number => data.sarsFields.find((f) => f.field === field)?.amount ?? 0;
  const net = amount('20');
  return (
    <div className="space-y-4">
      <TransactionTable title="Section A — Output Tax (Sales)" sectionColor="teal" invoices={data.outputInvoices} totalLabel="Total Output Tax (Field 13)" totalVat={amount('13')} />
      <TransactionTable title="Section B — Input Tax (Purchases)" sectionColor="blue" invoices={data.inputInvoices} totalLabel="Total Input Tax (Field 19)" totalVat={amount('19')} />
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] px-4 py-3 flex items-center justify-between">
        <span className="text-sm font-semibold text-[var(--ff-text-primary)]">
          Net VAT — Field 20 ({net >= 0 ? 'Payable to SARS' : 'Refundable from SARS'})
        </span>
        <span className={`text-lg font-bold ${net >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>{fmt(Math.abs(net))}</span>
      </div>
    </div>
  );
}
