/**
 * SupplierInvoiceSummary — Details grid and line items table for the supplier invoice detail page.
 */

import * as React from 'react';
import { formatCurrency } from '@/utils/formatters';
import type { SupplierInvoiceItem } from '@/modules/accounting/types/ap.types';

interface EditForm {
  invoiceNumber: string;
  dueDate: string;
  paymentTerms: string;
  notes: string;
}

interface Props {
  invoiceDate: string;
  dueDate?: string | null;
  paymentTerms?: string | null;
  poNumber?: string | null;
  subtotal: number;
  taxAmount: number;
  taxRate: number;
  totalAmount: number;
  balance: number;
  notes?: string | null;
  items: SupplierInvoiceItem[];
  editing: boolean;
  editForm: EditForm;
  onEditFormChange: (patch: Partial<EditForm>) => void;
}

export function SupplierInvoiceSummary({
  invoiceDate, dueDate, paymentTerms, poNumber,
  subtotal, taxAmount, taxRate, totalAmount, balance, notes,
  items, editing, editForm, onEditFormChange,
}: Props) {
  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
          <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">Invoice Date</p>
          <p className="text-lg font-semibold mt-1 text-[var(--ff-text-primary)]">{invoiceDate}</p>
        </div>
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
          <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">Due Date</p>
          {editing
            ? <input type="date" value={editForm.dueDate} onChange={e => onEditFormChange({ dueDate: e.target.value })} className="ff-input mt-1 text-sm w-full" />
            : <p className="text-lg font-semibold mt-1 text-[var(--ff-text-primary)]">{dueDate || '-'}</p>
          }
        </div>
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
          <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">Payment Terms</p>
          {editing
            ? <input value={editForm.paymentTerms} onChange={e => onEditFormChange({ paymentTerms: e.target.value })} className="ff-input mt-1 text-sm w-full" />
            : <p className="text-lg font-semibold mt-1 text-[var(--ff-text-primary)]">{paymentTerms || '-'}</p>
          }
        </div>
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
          <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">PO Number</p>
          <p className="text-lg font-semibold mt-1 text-[var(--ff-text-primary)]">{poNumber || '-'}</p>
        </div>
        {[
          { label: 'Subtotal', value: formatCurrency(subtotal) },
          { label: 'VAT', value: `${formatCurrency(taxAmount)} (${taxRate}%)` },
          { label: 'Total', value: formatCurrency(totalAmount), highlight: true },
          { label: 'Balance', value: formatCurrency(balance), highlight: balance > 0 },
        ].map((item, i) => (
          <div key={i} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
            <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">{item.label}</p>
            <p className={`text-lg font-semibold mt-1 ${item.highlight ? 'text-teal-500' : 'text-[var(--ff-text-primary)]'}`}>{item.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
        <div className="px-6 py-4 border-b border-[var(--ff-border-light)]">
          <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">Line Items</h3>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
              {['Description', 'Qty', 'Unit Price', 'Tax', 'Line Total'].map(h => (
                <th key={h} className={`px-4 py-3 text-xs font-medium text-[var(--ff-text-secondary)] uppercase ${h === 'Description' ? 'text-left' : 'text-right'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--ff-border-light)]">
            {(items || []).map(item => (
              <tr key={item.id} className="hover:bg-[var(--ff-bg-tertiary)]">
                <td className="px-4 py-3 text-sm text-[var(--ff-text-primary)]">{item.description}</td>
                <td className="px-4 py-3 text-sm text-right font-mono text-[var(--ff-text-secondary)]">{item.quantity}</td>
                <td className="px-4 py-3 text-sm text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(item.unitPrice)}</td>
                <td className="px-4 py-3 text-sm text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(item.taxAmount)}</td>
                <td className="px-4 py-3 text-sm text-right font-mono font-medium text-[var(--ff-text-primary)]">{formatCurrency(item.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[var(--ff-border-medium)] bg-[var(--ff-bg-tertiary)]">
              <td colSpan={3}></td>
              <td className="px-4 py-3 text-sm font-medium text-right text-[var(--ff-text-secondary)]">Total:</td>
              <td className="px-4 py-3 text-sm text-right font-mono font-bold text-teal-500">{formatCurrency(totalAmount)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {(notes || editing) && (
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
          <p className="text-xs text-[var(--ff-text-tertiary)] uppercase mb-1">Notes</p>
          {editing
            ? <textarea value={editForm.notes} onChange={e => onEditFormChange({ notes: e.target.value })} rows={3} className="ff-input mt-1 text-sm w-full resize-none" />
            : <p className="text-sm text-[var(--ff-text-secondary)]">{notes}</p>
          }
        </div>
      )}
    </>
  );
}
