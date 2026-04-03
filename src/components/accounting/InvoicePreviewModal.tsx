/**
 * InvoicePreviewModal — PDF-like preview of a customer invoice.
 * Accepts a full invoice object or an invoiceId to fetch from the API.
 */

import { useEffect, useState } from 'react';
import { Send, Download, Loader2, AlertCircle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { apiFetch } from '@/lib/apiFetch';

// ── Types ────────────────────────────────────────────────────────────────────

export interface InvoiceLineItem {
  id: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  tax_rate: number;
}

export interface InvoicePreviewData {
  id: string;
  invoice_number: string;
  client_name: string;
  client_email?: string;
  status: string;
  invoice_date: string | Date;
  due_date: string | Date;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  total_amount: number;
  amount_paid: number;
  notes?: string;
  items: InvoiceLineItem[];
  company_name?: string;
  company_logo?: string;
  company_address?: string;
  bank_name?: string;
  bank_account?: string;
  bank_branch?: string;
  payment_terms?: string;
}

interface InvoicePreviewModalProps {
  open: boolean;
  onClose: () => void;
  invoice?: InvoicePreviewData;
  invoiceId?: string;
  onSend?: (invoice: InvoicePreviewData) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const fmtDate = (d: string | Date | undefined): string => {
  if (!d) return '—';
  return (d instanceof Date ? d : new Date(d)).toLocaleDateString('en-ZA', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
};

// ── Invoice Document ─────────────────────────────────────────────────────────

function InvoiceDocument({ inv }: { inv: InvoicePreviewData }) {
  const balance = inv.total_amount - (inv.amount_paid ?? 0);
  const hasBank = inv.bank_name || inv.bank_account;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-8 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex justify-between items-start mb-8">
        <div>
          {inv.company_logo ? (
            <img src={inv.company_logo} alt="Logo" className="h-14 w-auto object-contain mb-2" />
          ) : (
            <div className="w-14 h-14 rounded bg-teal-100 dark:bg-teal-900/40 flex items-center justify-center mb-2">
              <span className="text-teal-600 dark:text-teal-400 font-bold text-lg">
                {(inv.company_name ?? 'C').charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <p className="font-bold text-gray-900 dark:text-gray-100">{inv.company_name ?? 'Your Company'}</p>
          {inv.company_address && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 whitespace-pre-line">{inv.company_address}</p>
          )}
        </div>
        <div className="text-right">
          <p className="text-3xl font-extrabold text-teal-600 dark:text-teal-400">INVOICE</p>
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mt-1">{inv.invoice_number}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            <span className="font-medium text-gray-700 dark:text-gray-300">Date: </span>{fmtDate(inv.invoice_date)}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            <span className="font-medium text-gray-700 dark:text-gray-300">Due: </span>{fmtDate(inv.due_date)}
          </p>
        </div>
      </div>

      {/* Bill To */}
      <div className="mb-6">
        <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">Bill To</p>
        <p className="font-semibold text-gray-800 dark:text-gray-100">{inv.client_name}</p>
        {inv.client_email && <p className="text-sm text-gray-500 dark:text-gray-400">{inv.client_email}</p>}
      </div>

      {/* Line Items */}
      <div className="mb-6 overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b-2 border-gray-300 dark:border-gray-600">
              {['Description', 'Qty', 'Unit Price', 'Amount'].map((h, i) => (
                <th key={h} className={`py-2 text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide ${i === 0 ? 'text-left pr-4 w-1/2' : 'text-right px-2'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {inv.items.map((item) => (
              <tr key={item.id}>
                <td className="py-2.5 pr-4 text-gray-800 dark:text-gray-200">{item.description}</td>
                <td className="py-2.5 px-2 text-right text-gray-600 dark:text-gray-400 tabular-nums">{item.quantity}</td>
                <td className="py-2.5 px-2 text-right text-gray-600 dark:text-gray-400 tabular-nums">{fmt(item.unit_price)}</td>
                <td className="py-2.5 pl-4 text-right font-medium text-gray-800 dark:text-gray-200 tabular-nums">{fmt(item.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Totals */}
      <div className="flex justify-end mb-6">
        <div className="w-56 space-y-1.5">
          <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400">
            <span>Subtotal</span><span className="tabular-nums">{fmt(inv.subtotal)}</span>
          </div>
          {inv.tax_amount > 0 && (
            <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400">
              <span>VAT ({inv.tax_rate}%)</span><span className="tabular-nums">{fmt(inv.tax_amount)}</span>
            </div>
          )}
          <div className="border-t border-gray-300 dark:border-gray-600 pt-1.5 flex justify-between font-bold text-gray-900 dark:text-gray-100">
            <span>Total</span><span className="tabular-nums">{fmt(inv.total_amount)}</span>
          </div>
          {inv.amount_paid > 0 && (
            <>
              <div className="flex justify-between text-sm text-green-600 dark:text-green-400">
                <span>Paid</span><span className="tabular-nums">({fmt(inv.amount_paid)})</span>
              </div>
              <div className="border-t border-gray-300 dark:border-gray-600 pt-1.5 flex justify-between font-bold text-teal-700 dark:text-teal-300">
                <span>Balance Due</span><span className="tabular-nums">{fmt(balance)}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Footer */}
      {(hasBank || inv.payment_terms || inv.notes) && (
        <div className="border-t border-gray-300 dark:border-gray-600 pt-4 space-y-2">
          {hasBank && (
            <div>
              <p className="text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide mb-0.5">Banking Details</p>
              <p className="text-xs text-gray-600 dark:text-gray-400">
                {[inv.bank_name, inv.bank_account, inv.bank_branch].filter(Boolean).join(' · ')}
              </p>
            </div>
          )}
          {inv.payment_terms && <p className="text-xs text-gray-500 dark:text-gray-400">{inv.payment_terms}</p>}
          {inv.notes && <p className="text-xs text-gray-500 dark:text-gray-400 italic">{inv.notes}</p>}
        </div>
      )}
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────

export function InvoicePreviewModal({ open, onClose, invoice, invoiceId, onSend }: InvoicePreviewModalProps) {
  const [fetched, setFetched] = useState<InvoicePreviewData | null>(null);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchError, setFetchError] = useState('');

  useEffect(() => {
    if (!open || !invoiceId || invoice) return;
    setFetchLoading(true);
    setFetchError('');
    void apiFetch(`/api/accounting/customer-invoices-detail?id=${invoiceId}`)
      .then(async (res) => {
        const json = await res.json() as { data?: InvoicePreviewData };
        setFetched(json.data ?? null);
      })
      .catch(() => setFetchError('Failed to load invoice.'))
      .finally(() => setFetchLoading(false));
  }, [open, invoiceId, invoice]);

  const inv = invoice ?? fetched;

  return (
    <Modal open={open} onClose={onClose} title="Invoice Preview" size="xl">
      <Modal.Body className="bg-gray-50 dark:bg-gray-900">
        {fetchLoading && (
          <div className="flex items-center justify-center py-16 gap-3 text-gray-500 dark:text-gray-400">
            <Loader2 className="w-6 h-6 animate-spin text-teal-500" />
            <span className="text-sm">Loading invoice…</span>
          </div>
        )}
        {fetchError && (
          <div className="flex items-center gap-3 p-4 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-lg text-sm">
            <AlertCircle className="w-5 h-5 shrink-0" />{fetchError}
          </div>
        )}
        {inv && <InvoiceDocument inv={inv} />}
      </Modal.Body>
      {inv && (
        <Modal.Footer>
          <Button variant="secondary" size="sm" leftIcon={Download}
            onClick={() => window.open(`/api/accounting/customer-invoice-pdf?id=${inv.id}`, '_blank')}>
            Download PDF
          </Button>
          {onSend && (
            <Button size="sm" leftIcon={Send} onClick={() => onSend(inv)}>
              Send Invoice
            </Button>
          )}
        </Modal.Footer>
      )}
    </Modal>
  );
}
