/**
 * Customer Payment Detail Page
 * View payment details, allocations, and perform actions (confirm/cancel)
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Wallet, Loader2, AlertCircle, Check, X } from 'lucide-react';
import { AccountingDocumentPanel } from '@/modules/accounting/documents';
import toast from 'react-hot-toast';

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-gray-500/20 text-gray-400',
    confirmed: 'bg-emerald-500/20 text-emerald-400',
    reconciled: 'bg-blue-500/20 text-blue-400',
    cancelled: 'bg-red-500/20 text-red-400',
  };
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-500/20 text-gray-400'}`}>
      {status}
    </span>
  );
}

interface Allocation {
  id: string;
  invoiceId: string;
  amountAllocated: number;
  invoiceNumber?: string;
}

interface Payment {
  id: string;
  paymentNumber: string;
  clientId: string;
  clientName?: string;
  paymentDate: string;
  totalAmount: number;
  paymentMethod: string;
  bankReference?: string;
  description?: string;
  status: string;
  glJournalEntryId?: string;
  allocations: Allocation[];
}

export default function CustomerPaymentDetailPage() {
  const router = useRouter();
  const paymentId = router.query.paymentId as string;

  const [payment, setPayment] = useState<Payment | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [acting, setActing] = useState(false);

  const loadPayment = useCallback(async () => {
    if (!paymentId) return;
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/accounting/customer-payments?id=${paymentId}`);
      const json = await res.json();
      const data = json.data || json;
      setPayment(data);
    } catch {
      setError('Failed to load payment');
    } finally {
      setIsLoading(false);
    }
  }, [paymentId]);

  useEffect(() => { loadPayment(); }, [loadPayment]);

  async function handleAction(action: 'confirm' | 'cancel') {
    if (!payment) return;

    if (action === 'cancel') {
      const reason = prompt('Reason for cancellation:');
      if (reason === null) return;
      setActing(true);
      try {
        const res = await fetch('/api/accounting/customer-payments-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ action: 'cancel', paymentId: payment.id, reason }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Cancel failed');
        toast.success('Payment cancelled');
        loadPayment();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to cancel');
      } finally {
        setActing(false);
      }
    } else {
      setActing(true);
      try {
        const res = await fetch('/api/accounting/customer-payments-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ action: 'confirm', paymentId: payment.id }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Confirm failed');
        toast.success('Payment confirmed and GL posted');
        loadPayment();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to confirm');
      } finally {
        setActing(false);
      }
    }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/accounting/customer-payments" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
                <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
              </Link>
              <div className="p-2 rounded-lg bg-emerald-500/10">
                <Wallet className="h-6 w-6 text-emerald-500" />
              </div>
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                    {payment?.paymentNumber || 'Payment'}
                  </h1>
                  {payment && <StatusBadge status={payment.status} />}
                </div>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  {payment?.clientName || 'Loading...'}
                </p>
              </div>
            </div>
            {payment && (
              <div className="flex gap-2">
                {payment.status === 'draft' && (
                  <button onClick={() => handleAction('confirm')} disabled={acting}
                    className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm disabled:opacity-50">
                    <Check className="h-4 w-4" /> Confirm & Post GL
                  </button>
                )}
                {payment.status === 'confirmed' && (
                  <button onClick={() => handleAction('cancel')} disabled={acting}
                    className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm disabled:opacity-50">
                    <X className="h-4 w-4" /> Cancel Payment
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="p-6 space-y-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-8 justify-center">
              <AlertCircle className="h-5 w-5" /><span>{error}</span>
            </div>
          ) : payment ? (
            <>
              {/* Payment Info */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: 'Amount', value: formatCurrency(payment.totalAmount) },
                  { label: 'Date', value: formatDate(payment.paymentDate) },
                  { label: 'Method', value: payment.paymentMethod.toUpperCase() },
                  { label: 'Bank Reference', value: payment.bankReference || '-' },
                ].map(item => (
                  <div key={item.label} className="p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                    <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">{item.label}</p>
                    <p className="text-sm font-medium text-[var(--ff-text-primary)]">{item.value}</p>
                  </div>
                ))}
              </div>

              {payment.description && (
                <div className="p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                  <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Description</p>
                  <p className="text-sm text-[var(--ff-text-primary)]">{payment.description}</p>
                </div>
              )}

              {payment.glJournalEntryId && (
                <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                  <Link href={`/accounting/journal-entries/${payment.glJournalEntryId}`}
                    className="text-sm text-blue-400 hover:text-blue-300">
                    View GL Journal Entry
                  </Link>
                </div>
              )}

              {/* Allocations */}
              <div>
                <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-3">Invoice Allocations</h2>
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--ff-border-light)]">
                        <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Invoice #</th>
                        <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Amount Allocated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payment.allocations.map(alloc => (
                        <tr key={alloc.id} className="border-b border-[var(--ff-border-light)]">
                          <td className="px-4 py-3">
                            <Link href={`/accounting/customer-invoices/${alloc.invoiceId}`}
                              className="text-blue-400 hover:text-blue-300 font-mono">
                              {alloc.invoiceNumber || alloc.invoiceId}
                            </Link>
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
                            {formatCurrency(alloc.amountAllocated)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Documents */}
              <AccountingDocumentPanel
                entityType="customer_payment"
                entityId={paymentId}
                allowedTypes={[
                  { value: 'proof_of_payment', label: 'Proof of Payment' },
                  { value: 'bank_statement', label: 'Bank Statement' },
                  { value: 'receipt', label: 'Receipt' },
                  { value: 'other', label: 'Other' },
                ]}
              />
            </>
          ) : null}
        </div>
      </div>
    </AppLayout>
  );
}
