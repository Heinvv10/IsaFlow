/**
 * Portal Pay Page — public-facing payment page for invoice payments via PayFast
 * No auth required. Uses payment link token for access.
 */

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

interface PaymentLinkData {
  invoiceId: string;
  clientId: string;
  amount: number;
  status: string;
  expiresAt: string;
  companyName?: string;
  invoiceNumber?: string;
  dueDate?: string;
  payfastFormData?: {
    paymentUrl: string;
    fields: Record<string, string>;
    transactionId: string;
  };
}

export default function PortalPayPage() {
  const router = useRouter();
  const { token } = router.query;
  const formRef = useRef<HTMLFormElement>(null);

  const [data, setData] = useState<PaymentLinkData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Check for return/cancel query params
  const isSuccess = router.query.payment_status === 'success' || router.query.status === 'success';
  const isCancelled = router.query.payment_status === 'cancelled' || router.query.status === 'cancelled';

  useEffect(() => {
    if (!token || isSuccess || isCancelled) {
      setLoading(false);
      return;
    }
    fetchPaymentLink();
  }, [token]);

  const fetchPaymentLink = async () => {
    try {
      const res = await fetch(`/api/portal/payment-link?token=${token}`);
      const json = await res.json();
      if (!res.ok || !json.data) {
        setError(json.error?.message || json.message || 'Payment link not found or expired');
        return;
      }
      setData(json.data);
    } catch {
      setError('Failed to load payment details');
    } finally {
      setLoading(false);
    }
  };

  const handlePayNow = () => {
    if (!data?.payfastFormData || !formRef.current) return;
    setSubmitting(true);
    formRef.current.submit();
  };

  // ── Success State ───────────────────────────────────────────────────────
  if (isSuccess) {
    return (
      <PageShell>
        <div className="text-center py-16">
          <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-emerald-500/10 flex items-center justify-center">
            <svg className="w-10 h-10 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Payment Successful</h2>
          <p className="text-gray-600 mb-8">
            Your payment has been received and is being processed. You will receive a confirmation email shortly.
          </p>
          <a href="/" className="text-blue-600 hover:text-blue-700 text-sm font-medium">
            Return to homepage
          </a>
        </div>
      </PageShell>
    );
  }

  // ── Cancelled State ─────────────────────────────────────────────────────
  if (isCancelled) {
    return (
      <PageShell>
        <div className="text-center py-16">
          <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-amber-500/10 flex items-center justify-center">
            <svg className="w-10 h-10 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Payment Cancelled</h2>
          <p className="text-gray-600 mb-8">
            Your payment was not completed. You can try again using the payment link.
          </p>
          {token && (
            <button
              onClick={() => router.replace(`/portal/pay/${token}`)}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
            >
              Try Again
            </button>
          )}
        </div>
      </PageShell>
    );
  }

  // ── Loading State ───────────────────────────────────────────────────────
  if (loading) {
    return (
      <PageShell>
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      </PageShell>
    );
  }

  // ── Error State ─────────────────────────────────────────────────────────
  if (error || !data) {
    return (
      <PageShell>
        <div className="text-center py-16">
          <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-red-500/10 flex items-center justify-center">
            <svg className="w-10 h-10 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Payment Unavailable</h2>
          <p className="text-gray-600">{error || 'This payment link is invalid or has expired.'}</p>
        </div>
      </PageShell>
    );
  }

  // ── Payment Form ────────────────────────────────────────────────────────
  return (
    <PageShell>
      <div className="max-w-lg mx-auto">
        {/* Invoice Summary */}
        <div className="bg-gray-50 rounded-xl p-6 mb-8">
          {data.companyName && (
            <p className="text-sm font-medium text-gray-500 mb-1">{data.companyName}</p>
          )}
          {data.invoiceNumber && (
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Invoice {data.invoiceNumber}</h2>
          )}
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="text-sm text-gray-600">Amount Due</span>
              <span className="text-xl font-bold text-gray-900">{fmt(data.amount)}</span>
            </div>
            {data.dueDate && (
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Due Date</span>
                <span className="text-sm font-medium text-gray-900">{data.dueDate.split('T')[0]}</span>
              </div>
            )}
          </div>
        </div>

        {/* PayFast Payment Button */}
        {data.payfastFormData ? (
          <>
            <form
              ref={formRef}
              action={data.payfastFormData.paymentUrl}
              method="POST"
              className="hidden"
            >
              {Object.entries(data.payfastFormData.fields).map(([key, value]) => (
                <input key={key} type="hidden" name={key} value={value} />
              ))}
            </form>

            <button
              onClick={handlePayNow}
              disabled={submitting}
              className="w-full py-4 bg-[#00457C] text-white rounded-xl font-semibold text-lg hover:bg-[#003460] transition-colors disabled:opacity-50 flex items-center justify-center gap-3"
            >
              {submitting ? (
                <>
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Redirecting to PayFast...
                </>
              ) : (
                <>
                  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM4 0h16v2H4zm0 22h16v2H4z" />
                  </svg>
                  Pay Now with PayFast
                </>
              )}
            </button>

            <div className="mt-4 flex items-center justify-center gap-2 text-xs text-gray-400">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <span>Secured by PayFast. Card details are never stored on our servers.</span>
            </div>
          </>
        ) : (
          <div className="text-center py-8 text-gray-500">
            <p>Online payment is not currently available for this invoice.</p>
            <p className="text-sm mt-2">Please contact the billing department for alternative payment methods.</p>
          </div>
        )}
      </div>
    </PageShell>
  );
}

// ── Shell Component ─────────────────────────────────────────────────────────

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Head>
        <title>Pay Invoice | ISAFlow</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <div className="min-h-screen bg-white">
        {/* Header */}
        <header className="border-b border-gray-200 bg-white">
          <div className="max-w-2xl mx-auto px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
                <span className="text-white font-bold text-sm">IS</span>
              </div>
              <span className="font-semibold text-gray-900">ISAFlow</span>
            </div>
            <span className="text-xs text-gray-400">Secure Payment</span>
          </div>
        </header>

        {/* Content */}
        <main className="max-w-2xl mx-auto px-6 py-12">
          {children}
        </main>

        {/* Footer */}
        <footer className="border-t border-gray-100 mt-auto">
          <div className="max-w-2xl mx-auto px-6 py-6 text-center text-xs text-gray-400">
            Powered by ISAFlow Accounting
          </div>
        </footer>
      </div>
    </>
  );
}
