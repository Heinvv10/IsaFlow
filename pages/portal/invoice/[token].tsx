/**
 * Portal Invoice Page — Public, no auth required
 * Customers view invoice details via a secure token link.
 * Uses getServerSideProps for SSR (no flash, SEO-friendly).
 */

import type { GetServerSideProps } from 'next';
import Head from 'next/head';
import { useState } from 'react';
import { FileText, Download, CreditCard, CheckCircle2, AlertTriangle, Clock, XCircle } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LineItem {
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  amount: number;
}

interface PortalInvoiceProps {
  invoice: {
    invoice_number: string;
    invoice_date: string;
    due_date: string | null;
    status: string;
    currency_code: string;
    subtotal: number;
    tax_amount: number;
    total_amount: number;
    amount_paid: number;
    notes: string | null;
    customer_name: string;
    company_name: string;
    company_logo_url: string | null;
    portal_display_name: string | null;
    portal_primary_color: string | null;
    portal_allow_payments: boolean;
    portal_payment_instructions: string | null;
    items: LineItem[];
  };
  token: string;
  isOverdue: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(amount: number, currency = 'ZAR'): string {
  if (currency === 'ZAR') {
    return 'R ' + Math.abs(amount).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency }).format(amount);
}

const STATUS_META: Record<string, { label: string; icon: React.ReactNode; classes: string }> = {
  draft:    { label: 'Draft',    icon: <Clock className="h-3.5 w-3.5" />,        classes: 'bg-gray-100 text-gray-600' },
  sent:     { label: 'Sent',     icon: <FileText className="h-3.5 w-3.5" />,     classes: 'bg-blue-50 text-blue-700' },
  approved: { label: 'Approved', icon: <CheckCircle2 className="h-3.5 w-3.5" />, classes: 'bg-teal-50 text-teal-700' },
  paid:     { label: 'Paid',     icon: <CheckCircle2 className="h-3.5 w-3.5" />, classes: 'bg-emerald-50 text-emerald-700' },
  partially_paid: { label: 'Partially Paid', icon: <Clock className="h-3.5 w-3.5" />, classes: 'bg-amber-50 text-amber-700' },
  overdue:  { label: 'Overdue',  icon: <AlertTriangle className="h-3.5 w-3.5" />, classes: 'bg-red-50 text-red-700' },
  cancelled:{ label: 'Cancelled',icon: <XCircle className="h-3.5 w-3.5" />,      classes: 'bg-gray-100 text-gray-500' },
};

// ── Payment Modal ─────────────────────────────────────────────────────────────

function PayModal({ onClose, paymentInstructions, accentColor }: {
  onClose: () => void;
  paymentInstructions: string | null;
  accentColor: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-teal-50 flex items-center justify-center">
            <CreditCard className="h-5 w-5" style={{ color: accentColor }} />
          </div>
          <h2 className="text-lg font-semibold text-gray-900">Pay Invoice</h2>
        </div>
        {paymentInstructions ? (
          <p className="text-sm text-gray-700 whitespace-pre-wrap mb-6">{paymentInstructions}</p>
        ) : (
          <p className="text-sm text-gray-600 mb-6">
            To arrange payment for this invoice, please contact us directly and we will assist you with the payment process.
          </p>
        )}
        <button
          onClick={onClose}
          className="w-full text-slate-900 dark:text-white font-medium text-sm px-4 py-2.5 rounded-lg transition-colors"
          style={{ backgroundColor: accentColor }}
        >
          Close
        </button>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PortalInvoicePage({ invoice, token, isOverdue }: PortalInvoiceProps) {
  const [showPayModal, setShowPayModal] = useState(false);

  const displayStatus = isOverdue && invoice.status === 'sent' ? 'overdue' : invoice.status;
  const statusMeta = STATUS_META[displayStatus] ?? STATUS_META['sent']!;
  const balance = invoice.total_amount - invoice.amount_paid;
  const isPaid = invoice.status === 'paid' || balance <= 0;
  const canPay = !isPaid && !['draft', 'cancelled'].includes(invoice.status) && invoice.portal_allow_payments;

  const headerName = invoice.portal_display_name ?? invoice.company_name;
  const accentColor = invoice.portal_primary_color ?? '#0d9488';

  return (
    <>
      <Head>
        <title>Invoice {invoice.invoice_number} — {invoice.company_name}</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>

      <div className="min-h-screen bg-gray-50">
        {/* Header bar */}
        <div className="bg-white border-b border-gray-200 px-4 py-3">
          <div className="max-w-3xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              {invoice.company_logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={invoice.company_logo_url} alt={headerName} className="h-8 w-auto object-contain" />
              ) : (
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: accentColor }}>
                  <FileText className="w-4 h-4 text-slate-900 dark:text-white" />
                </div>
              )}
              <span className="font-semibold text-gray-900 text-sm">{headerName}</span>
            </div>
            <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${statusMeta.classes}`}>
              {statusMeta.icon}
              {statusMeta.label}
              {isOverdue && invoice.status !== 'paid' && invoice.status !== 'cancelled' && (
                <span className="ml-1 text-red-600 font-bold">OVERDUE</span>
              )}
            </div>
          </div>
        </div>

        <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
          {/* Invoice Header */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
            <div className="flex items-start justify-between mb-6">
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Tax Invoice</h1>
                <p className="text-teal-600 font-semibold mt-0.5">{invoice.invoice_number}</p>
              </div>
              <div className="text-right text-sm text-gray-600">
                <p><span className="font-medium text-gray-900">Billed to:</span></p>
                <p className="text-gray-700">{invoice.customer_name}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-4 border-t border-gray-100">
              <div>
                <p className="text-xs uppercase text-gray-500 tracking-wide mb-1">Invoice Date</p>
                <p className="text-sm font-medium text-gray-900">
                  {new Date(invoice.invoice_date).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase text-gray-500 tracking-wide mb-1">Due Date</p>
                <p className={`text-sm font-medium ${isOverdue && !isPaid ? 'text-red-600' : 'text-gray-900'}`}>
                  {invoice.due_date
                    ? new Date(invoice.due_date).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })
                    : 'On receipt'}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase text-gray-500 tracking-wide mb-1">Currency</p>
                <p className="text-sm font-medium text-gray-900">{invoice.currency_code}</p>
              </div>
            </div>
          </div>

          {/* Line Items */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Line Items</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    <th className="text-left px-6 py-3 font-medium text-gray-500">Description</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500">Qty</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500">Unit Price</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500">VAT %</th>
                    <th className="text-right px-6 py-3 font-medium text-gray-500">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {invoice.items.map((item, i) => (
                    <tr key={i} className="hover:bg-gray-50/50">
                      <td className="px-6 py-3.5 text-gray-800">{item.description || '—'}</td>
                      <td className="px-4 py-3.5 text-right text-gray-700 tabular-nums">{item.quantity}</td>
                      <td className="px-4 py-3.5 text-right text-gray-700 tabular-nums">{fmt(item.unit_price, invoice.currency_code)}</td>
                      <td className="px-4 py-3.5 text-right text-gray-500 tabular-nums">{item.tax_rate}%</td>
                      <td className="px-6 py-3.5 text-right font-medium text-gray-900 tabular-nums">{fmt(item.amount, invoice.currency_code)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="border-t border-gray-200 px-6 py-4 space-y-2">
              <div className="flex justify-between text-sm text-gray-600">
                <span>Subtotal</span>
                <span className="tabular-nums">{fmt(invoice.subtotal, invoice.currency_code)}</span>
              </div>
              <div className="flex justify-between text-sm text-gray-600">
                <span>VAT</span>
                <span className="tabular-nums">{fmt(invoice.tax_amount, invoice.currency_code)}</span>
              </div>
              {invoice.amount_paid > 0 && (
                <div className="flex justify-between text-sm text-emerald-600">
                  <span>Amount Paid</span>
                  <span className="tabular-nums">−{fmt(invoice.amount_paid, invoice.currency_code)}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-bold text-gray-900 pt-2 border-t border-gray-200">
                <span>{isPaid ? 'Total (Paid)' : 'Balance Due'}</span>
                <span className={`tabular-nums ${isPaid ? 'text-emerald-600' : isOverdue ? 'text-red-600' : 'text-gray-900'}`}>
                  {fmt(isPaid ? invoice.total_amount : balance, invoice.currency_code)}
                </span>
              </div>
            </div>
          </div>

          {/* Notes */}
          {invoice.notes && (
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
              <p className="text-xs uppercase text-gray-500 tracking-wide mb-2">Notes</p>
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{invoice.notes}</p>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-3">
            {canPay && (
              <button
                onClick={() => setShowPayModal(true)}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-slate-900 dark:text-white font-medium text-sm rounded-xl transition-colors shadow-sm hover:opacity-90"
                style={{ backgroundColor: accentColor }}
              >
                <CreditCard className="h-4 w-4" />
                Pay Now
              </button>
            )}
            <a
              href={`/api/accounting/invoice-pdf?invoiceId=${token}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-5 py-2.5 border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm rounded-xl transition-colors"
            >
              <Download className="h-4 w-4" />
              Download PDF
            </a>
          </div>

          {/* Footer */}
          <p className="text-center text-xs text-gray-600 dark:text-gray-400 pb-8">
            Powered by ISAFlow &mdash; Cloud Accounting for South Africa
          </p>
        </div>
      </div>

      {showPayModal && (
        <PayModal
          onClose={() => setShowPayModal(false)}
          paymentInstructions={invoice.portal_payment_instructions}
          accentColor={accentColor}
        />
      )}
    </>
  );
}

// ── Server-side Data Fetching ─────────────────────────────────────────────────

export const getServerSideProps: GetServerSideProps = async (context) => {
  const token = context.params?.token as string;

  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return { notFound: true };
  }

  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3101';
    const res = await fetch(`${baseUrl}/api/portal/invoice/${token}`);

    if (!res.ok) {
      return { notFound: true };
    }

    const json = await res.json() as { success: boolean; data: PortalInvoiceProps['invoice'] };
    if (!json.success || !json.data) {
      return { notFound: true };
    }

    const invoice = json.data;
    const isOverdue = Boolean(
      invoice.due_date &&
      new Date(invoice.due_date) < new Date() &&
      !['paid', 'cancelled'].includes(invoice.status)
    );

    return {
      props: { invoice, token, isOverdue },
    };
  } catch {
    return { notFound: true };
  }
};
