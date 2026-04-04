import { FileDigit } from 'lucide-react';
import { DocumentNumber, INPUT_CLS, LABEL_CLS, SECTION_CLS } from './settingsTypes';

interface Props {
  docNumbers: DocumentNumber[];
  messages: Record<string, string>;
  docDisplayFields: Record<string, boolean>;
  onDocNumChange: (docType: string, field: 'prefix' | 'nextNumber', value: string | number) => void;
  onMessageChange: (key: string, value: string) => void;
  onDisplayFieldChange: (key: string, checked: boolean) => void;
}

const DOC_NUMBER_LABELS: Record<string, string> = {
  quotation: 'Quotation', sales_order: 'Sales Order', customer_invoice: 'Customer Invoice',
  credit_note: 'Credit Note', customer_receipt: 'Customer Receipt', customer_write_off: 'Customer Write-Off',
  recurring_invoice: 'Recurring Invoice', customer_adjustment: 'Customer Adjustment',
  purchase_order: 'Purchase Order', supplier_invoice: 'Supplier Invoice',
  supplier_return: 'Supplier Return', supplier_payment: 'Supplier Payment',
  supplier_adjustment: 'Supplier Adjustment', delivery_note: 'Delivery Note',
};

const STATEMENT_MSG_TYPES = [
  { key: 'statement_current', label: 'Current' },
  { key: 'statement_30', label: 'In 30 Days' },
  { key: 'statement_60', label: 'In 60 Days' },
  { key: 'statement_90', label: 'In 90 Days' },
  { key: 'statement_120', label: 'In 120+ Days' },
];

const CUSTOMER_MSG_TYPES = [
  { key: 'msg_customer_quote', label: 'Quote' },
  { key: 'msg_customer_so', label: 'Sales Order' },
  { key: 'msg_customer_invoice', label: 'Customer Invoice' },
  { key: 'msg_customer_credit_note', label: 'Credit Note' },
  { key: 'msg_customer_receipt', label: 'Receipt' },
  { key: 'msg_customer_write_off', label: 'Write-Off' },
  { key: 'msg_customer_bad_debt_relief', label: 'Bad Debt Relief' },
  { key: 'msg_customer_bad_debt_recovered', label: 'Bad Debt Recovered' },
];

const SUPPLIER_MSG_TYPES = [
  { key: 'msg_supplier_po', label: 'Purchase Order' },
  { key: 'msg_supplier_invoice', label: 'Supplier Invoice' },
  { key: 'msg_supplier_return', label: 'Supplier Return' },
  { key: 'msg_supplier_payment', label: 'Payment' },
  { key: 'msg_supplier_output_tax_adj', label: 'Output Tax Adjustment' },
  { key: 'msg_supplier_input_tax_adj', label: 'Input Tax Adjustment' },
];

const DISPLAY_FIELDS = [
  { key: 'registrationNumber', label: 'Registration Number' },
  { key: 'vatNumber', label: 'VAT Number' },
  { key: 'companyDirectors', label: 'Company Directors' },
  { key: 'physicalAddress', label: 'Physical Address' },
  { key: 'phoneNumber', label: 'Phone Number' },
  { key: 'emailAddress', label: 'Email Address' },
  { key: 'website', label: 'Website' },
  { key: 'socialMediaLinks', label: 'Social Media Links' },
];

export function DocumentsTab({ docNumbers, messages, docDisplayFields, onDocNumChange, onMessageChange, onDisplayFieldChange }: Props) {
  return (
    <>
      {/* Document Numbers */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4 flex items-center gap-2">
          <FileDigit className="h-5 w-5" /> Document Numbers
        </h2>
        <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">Configure the prefix and next number for each document type.</p>
        {docNumbers.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[var(--ff-text-secondary)] border-b border-[var(--ff-border-primary)]">
                <th className="pb-2 font-medium">Document Type</th>
                <th className="pb-2 font-medium">Prefix</th>
                <th className="pb-2 font-medium">Next Number</th>
                <th className="pb-2 font-medium">Preview</th>
              </tr></thead>
              <tbody>
                {docNumbers.map(d => (
                  <tr key={d.documentType} className="border-b border-[var(--ff-border-primary)] last:border-0">
                    <td className="py-2 text-[var(--ff-text-primary)]">{DOC_NUMBER_LABELS[d.documentType] || d.documentType}</td>
                    <td className="py-2"><input className={`${INPUT_CLS} max-w-[100px]`} value={d.prefix} onChange={e => onDocNumChange(d.documentType, 'prefix', e.target.value)} /></td>
                    <td className="py-2"><input type="number" min="1" className={`${INPUT_CLS} max-w-[120px]`} value={d.nextNumber} onChange={e => onDocNumChange(d.documentType, 'nextNumber', Number(e.target.value))} /></td>
                    <td className="py-2 text-[var(--ff-text-tertiary)] font-mono text-xs">{d.prefix}{String(d.nextNumber).padStart(d.padding, '0')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-[var(--ff-text-tertiary)] text-center py-4">Loading document numbers...</p>}
      </section>

      {/* Statement Messages */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Statement Messages</h2>
        <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">Messages that print on customer statements based on the oldest outstanding balance.</p>
        <div className="space-y-3">
          {STATEMENT_MSG_TYPES.map(m => (
            <div key={m.key}>
              <label className={LABEL_CLS}>{m.label}</label>
              <input className={INPUT_CLS} value={messages[m.key] || ''} onChange={e => onMessageChange(m.key, e.target.value)} placeholder={`Message for ${m.label.toLowerCase()} balances...`} />
            </div>
          ))}
        </div>
      </section>

      {/* Customer Document Messages */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Customer Document Messages</h2>
        <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">Default message that prints on each document type. Can be changed per document.</p>
        <div className="space-y-3">
          {CUSTOMER_MSG_TYPES.map(m => (
            <div key={m.key}>
              <label className={LABEL_CLS}>{m.label}</label>
              <textarea className={INPUT_CLS} rows={2} value={messages[m.key] || ''} onChange={e => onMessageChange(m.key, e.target.value)} placeholder={`Default message for ${m.label.toLowerCase()}...`} />
            </div>
          ))}
        </div>
      </section>

      {/* Supplier Document Messages */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Supplier Document Messages</h2>
        <div className="space-y-3">
          {SUPPLIER_MSG_TYPES.map(m => (
            <div key={m.key}>
              <label className={LABEL_CLS}>{m.label}</label>
              <textarea className={INPUT_CLS} rows={2} value={messages[m.key] || ''} onChange={e => onMessageChange(m.key, e.target.value)} placeholder={`Default message for ${m.label.toLowerCase()}...`} />
            </div>
          ))}
        </div>
      </section>

      {/* Information displayed on documents */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1">Information displayed on documents</h2>
        <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">Choose which company details appear on generated invoices, statements, and other documents.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {DISPLAY_FIELDS.map(field => (
            <label key={field.key} className="flex items-center gap-3 cursor-pointer p-2 rounded-lg hover:bg-[var(--ff-bg-primary)] transition-colors">
              <input
                type="checkbox"
                checked={docDisplayFields[field.key] ?? false}
                onChange={e => onDisplayFieldChange(field.key, e.target.checked)}
                className="h-4 w-4 accent-teal-500"
              />
              <span className="text-sm text-[var(--ff-text-primary)]">{field.label}</span>
            </label>
          ))}
        </div>
      </section>
    </>
  );
}
