/**
 * Supplier Payment Detail Page
 * View payment info, allocations, approve/process/cancel
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Wallet, Loader2, AlertCircle, Check, Zap } from 'lucide-react';
import { AccountingDocumentPanel } from '@/modules/accounting/documents';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { ConfirmDialog } from '@/components/accounting/ConfirmDialog';

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-gray-500/20 text-gray-400',
    approved: 'bg-amber-500/20 text-amber-400',
    processed: 'bg-teal-500/20 text-teal-400',
    reconciled: 'bg-blue-500/20 text-blue-400',
    cancelled: 'bg-red-500/20 text-red-400',
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${colors[status] || ''}`}>
      {status}
    </span>
  );
}

// The API's own field names (mapAllocationRow): reading `invoice_number` and
// `amount` showed the invoice UUID and "RNaN" on every line.
interface Allocation {
  id: string;
  invoiceId: string;
  invoiceNumber?: string;
  amountAllocated: number;
}

interface PaymentDetail {
  id: string;
  paymentNumber: string;
  supplierId: number;
  supplierName: string;
  paymentDate: string;
  totalAmount: number;
  paymentMethod: string;
  bankAccountId?: string;
  reference?: string;
  description?: string;
  status: string;
  journalEntryId?: string;
  batchId?: string;
  allocations: Allocation[];
}

export default function SupplierPaymentDetailPage() {
  const router = useRouter();
  const paymentId = router.query.paymentId as string;

  const [payment, setPayment] = useState<PaymentDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionBusy, setActionBusy] = useState('');
  const [confirming, setConfirming] = useState<'' | 'cancel' | 'void'>('');

  const load = useCallback(async () => {
    if (!paymentId) return;
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/supplier-payments?id=${paymentId}`);
      const json = await res.json();
      setPayment(json.data || null);
    } catch {
      setError('Failed to load payment');
    } finally {
      setIsLoading(false);
    }
  }, [paymentId]);

  useEffect(() => { void load(); }, [load]);

  async function handleAction(action: string) {
    if (!payment) return;
    setActionBusy(action);
    try {
      const res = await apiFetch('/api/accounting/supplier-payments-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, paymentId: payment.id }),
      });
      // The body's `error` is an object ({ code, message }); rendering it
      // crashed the page. `assertOk` pulls out the refusal's own message.
      await assertOk(res, `Failed to ${action} payment`);
      void load();
    } catch (err) {
      setError(apiErrorMessage(err, `Failed to ${action} payment`));
    } finally {
      setActionBusy('');
    }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/accounting/supplier-payments" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
                <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
              </Link>
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Wallet className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                  {payment?.paymentNumber || 'Payment Detail'}
                </h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  {payment?.supplierName || 'Loading...'}
                </p>
              </div>
              {payment && <StatusBadge status={payment.status} />}
            </div>
            {payment && payment.batchId && (
              // A batch member moves money only through its batch; every Process,
              // Void or Cancel here would answer 400, so none is offered.
              <div className="text-sm text-[var(--ff-text-secondary)]">
                This payment is managed in its batch —{' '}
                <Link href={`/accounting/batch-payments/${payment.batchId}`} className="text-indigo-400 hover:underline">
                  open the batch
                </Link>
              </div>
            )}
            {payment && !payment.batchId && (
              <div className="flex items-center gap-2">
                {payment.status === 'draft' && (
                  <button onClick={() => handleAction('approve')} disabled={!!actionBusy}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50">
                    {actionBusy === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Approve
                  </button>
                )}
                {payment.status === 'approved' && (
                  <button onClick={() => handleAction('process')} disabled={!!actionBusy}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50">
                    {actionBusy === 'process' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />} Process
                  </button>
                )}
                {/* Cancel = money never moved; Void = reverse money that did. */}
                {(payment.status === 'draft' || payment.status === 'approved') && (
                  <button onClick={() => setConfirming('cancel')} disabled={!!actionBusy}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-red-600/10 text-red-400 rounded-lg hover:bg-red-600/20 text-sm font-medium disabled:opacity-50">
                    Cancel payment
                  </button>
                )}
                {payment.status === 'processed' && (
                  <button onClick={() => setConfirming('void')} disabled={!!actionBusy}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-red-600/10 text-red-400 rounded-lg hover:bg-red-600/20 text-sm font-medium disabled:opacity-50">
                    Void (reverse journal)
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="p-6 space-y-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-8 justify-center">
              <AlertCircle className="h-5 w-5" /><span>{error}</span>
            </div>
          ) : payment ? (
            <>
              {/* Info Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                  <p className="text-xs text-[var(--ff-text-tertiary)]">Payment Amount</p>
                  <p className="text-xl font-bold text-teal-400">{formatCurrency(payment.totalAmount)}</p>
                </div>
                <div className="p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                  <p className="text-xs text-[var(--ff-text-tertiary)]">Payment Date</p>
                  <p className="text-lg font-medium text-[var(--ff-text-primary)]">{formatDate(payment.paymentDate)}</p>
                </div>
                <div className="p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                  <p className="text-xs text-[var(--ff-text-tertiary)]">Method</p>
                  <p className="text-lg font-medium text-[var(--ff-text-primary)] uppercase">{payment.paymentMethod || '-'}</p>
                </div>
                <div className="p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                  <p className="text-xs text-[var(--ff-text-tertiary)]">Allocations</p>
                  <p className="text-lg font-medium text-[var(--ff-text-primary)]">{payment.allocations?.length || 0} invoice(s)</p>
                </div>
              </div>

              {/* Details */}
              {(payment.reference || payment.description) && (
                <div className="p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                  {payment.reference && <p className="text-sm text-[var(--ff-text-secondary)]">Reference: <span className="text-[var(--ff-text-primary)] font-mono">{payment.reference}</span></p>}
                  {payment.description && <p className="text-sm text-[var(--ff-text-secondary)] mt-1">{payment.description}</p>}
                </div>
              )}

              {/* Allocations Table */}
              {payment.allocations && payment.allocations.length > 0 && (
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
                  <div className="px-4 py-3 border-b border-[var(--ff-border-light)]">
                    <h3 className="text-sm font-medium text-[var(--ff-text-primary)]">Invoice Allocations</h3>
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--ff-border-light)]">
                        <th className="px-4 py-3 text-left text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Invoice</th>
                        <th className="px-4 py-3 text-right text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Amount Allocated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payment.allocations.map((a, i) => (
                        <tr key={a.id || i} className="border-b border-[var(--ff-border-light)]">
                          <td className="px-4 py-3 text-[var(--ff-text-primary)] font-mono">
                            {a.invoiceNumber || a.invoiceId}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
                            {formatCurrency(Number(a.amountAllocated))}
                          </td>
                        </tr>
                      ))}
                      <tr className="bg-[var(--ff-bg-tertiary)] font-bold">
                        <td className="px-4 py-3 text-[var(--ff-text-primary)]">Total</td>
                        <td className="px-4 py-3 text-right font-mono text-teal-400">{formatCurrency(payment.totalAmount)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}

              {/* GL Link */}
              {payment.journalEntryId && (
                <div className="text-sm text-[var(--ff-text-tertiary)]">
                  GL Journal: <Link href={`/accounting?tab=journal-entries&id=${payment.journalEntryId}`} className="text-teal-400 hover:underline">{payment.journalEntryId.slice(0, 8)}...</Link>
                </div>
              )}

              {/* Documents */}
              <AccountingDocumentPanel
                entityType="supplier_payment"
                entityId={paymentId}
                allowedTypes={[
                  { value: 'proof_of_payment', label: 'Proof of Payment' },
                  { value: 'remittance_advice', label: 'Remittance Advice' },
                  { value: 'receipt', label: 'Receipt' },
                  { value: 'other', label: 'Other' },
                ]}
              />
            </>
          ) : null}
        </div>
      </div>
      <ConfirmDialog
        open={confirming !== ''}
        title={confirming === 'void' ? 'Void this processed payment?' : 'Cancel this payment?'}
        message={confirming === 'void'
          ? 'The payment has been posted. Void reverses its journal (DR Bank / CR Accounts Payable) and reopens the bills it paid.'
          : 'Nothing has been posted for this payment yet. Cancelling stops it for good and releases the bills it was going to pay — no journal is created or reversed. To undo a payment that has already been processed, use Void instead.'}
        confirmLabel={confirming === 'void' ? 'Void payment' : 'Cancel payment'}
        cancelLabel="Keep it"
        confirmTone="danger"
        busy={actionBusy !== ''}
        onConfirm={() => { const a = confirming; setConfirming(''); if (a) void handleAction(a); }}
        onCancel={() => setConfirming('')}
      />
    </AppLayout>
  );
}
