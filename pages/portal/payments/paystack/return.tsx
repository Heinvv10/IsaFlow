/**
 * Paystack — customer invoice payment return landing.
 * Public route; payer has no ISAFlow session. Paystack appends ?reference=
 * (and we also pass &ref= ourselves for symmetry). Final status is verified
 * server-side via /api/portal/payments/paystack/verify.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';
import { CheckCircle2, XCircle, Loader2, AlertTriangle } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';

type VerifyState = 'verifying' | 'completed' | 'failed' | 'cancelled' | 'confirming' | 'error';

interface VerifyResponse {
  status: 'completed' | 'failed' | 'cancelled' | 'pending';
  /** What was banked once settled (R-181), else the checkout amount. */
  amountCents: number;
  /** Whether the invoice took any of it; false when it was banked unapplied. */
  appliedToInvoice?: boolean;
  /** ISO currency the payment was reported in; a figure is shown only for ZAR. */
  currency?: string;
  invoiceNumber?: string;
  companyName?: string;
}

/**
 * A payment still pending after this many polls (10 polls, 3 s apart) stops on a neutral
 * "still confirming" state. Unbounded, it ran into verify's per-IP rate limit and
 * ended on an error for a payer who may well have been charged.
 */
const MAX_POLLS = 10;
const POLL_MS = 3000;
const RATE_LIMITED = 429;

const fmtZAR = (cents: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(cents / 100);

export default function PaystackReturnPage() {
  const router = useRouter();
  const [state, setState] = useState<VerifyState>('verifying');
  const [data, setData] = useState<VerifyResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!router.isReady) return;
    const { ref, reference } = router.query;
    const r = typeof ref === 'string' ? ref
            : typeof reference === 'string' ? reference : '';
    if (!r) {
      setState('error');
      setErrorMsg('Missing payment reference.');
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        for (let poll = 1; poll <= MAX_POLLS; poll += 1) {
          const res = await apiFetch(
            `/api/portal/payments/paystack/verify?ref=${encodeURIComponent(r)}`,
          );
          if (cancelled) return;
          if (res.status === RATE_LIMITED) break;
          await assertOk(res, 'We could not confirm this payment - please check your payment status or contact support');
          const verified = ((await res.json()) as { data: VerifyResponse }).data;
          if (cancelled) return;
          setData(verified);
          if (verified.status === 'completed') return setState('completed');
          if (verified.status === 'failed') return setState('failed');
          if (verified.status === 'cancelled') return setState('cancelled');
          if (poll < MAX_POLLS) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          if (cancelled) return;
        }
        setState('confirming');
      } catch (err) {
        if (cancelled) return;
        setData(null);
        setState('error');
        setErrorMsg(apiErrorMessage(err, 'We could not confirm this payment - please check your payment status or contact support'));
      }
    })();
    return () => { cancelled = true; };
  }, [router.isReady, router.query]);

  return (
    <>
      <Head><title>Payment — IsaFlow</title></Head>
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          {state === 'verifying' && (
            <div className="text-center">
              <Loader2 className="w-12 h-12 text-indigo-600 mx-auto animate-spin" />
              <h1 className="mt-4 text-xl font-semibold text-slate-900">Confirming payment…</h1>
              <p className="mt-2 text-sm text-slate-600">
                We are verifying this with your bank. Do not close this window.
              </p>
            </div>
          )}

          {state === 'completed' && data && (
            <div className="text-center">
              <CheckCircle2 className="w-14 h-14 text-emerald-600 mx-auto" />
              <h1 className="mt-4 text-2xl font-semibold text-slate-900">Payment received</h1>
              <p className="mt-2 text-slate-600">
                {data.currency && data.currency !== 'ZAR'
                  ? 'Thank you. Your payment has been received'
                  : `Thank you. ${fmtZAR(data.amountCents)} has been received`}
                {data.appliedToInvoice && data.invoiceNumber ? ` against invoice ${data.invoiceNumber}` : ''}.
              </p>
              {data.companyName && (
                <p className="mt-1 text-sm text-slate-500">Paid to {data.companyName}</p>
              )}
              <p className="mt-6 text-xs text-slate-400">
                You can close this window.
              </p>
            </div>
          )}

          {state === 'confirming' && (
            <div className="text-center">
              <Loader2 className="w-12 h-12 text-indigo-600 mx-auto" />
              <h1 className="mt-4 text-xl font-semibold text-slate-900">Still confirming your payment</h1>
              <p className="mt-2 text-sm text-slate-600">
                Your bank has not confirmed this payment to us yet. If your account was debited, it
                will be recorded shortly. Please check back later, or contact
                {data?.companyName ? ` ${data.companyName}` : ' the sender'} if it does not update.
              </p>
            </div>
          )}

          {state === 'failed' && (
            <div className="text-center">
              <XCircle className="w-14 h-14 text-rose-600 mx-auto" />
              <h1 className="mt-4 text-2xl font-semibold text-slate-900">Payment failed</h1>
              <p className="mt-2 text-slate-600">
                The bank did not complete this payment. No money has left your account.
              </p>
              <Link
                href="#"
                onClick={(e) => { e.preventDefault(); router.back(); }}
                className="mt-6 inline-block rounded-lg bg-indigo-600 px-5 py-2.5 text-white text-sm font-medium hover:bg-indigo-700"
              >
                Try again
              </Link>
            </div>
          )}

          {state === 'cancelled' && (
            <div className="text-center">
              <AlertTriangle className="w-14 h-14 text-amber-500 mx-auto" />
              <h1 className="mt-4 text-2xl font-semibold text-slate-900">Payment cancelled</h1>
              <p className="mt-2 text-slate-600">
                You cancelled the payment before it completed. No money has left your account.
              </p>
              <Link
                href="#"
                onClick={(e) => { e.preventDefault(); router.back(); }}
                className="mt-6 inline-block rounded-lg bg-indigo-600 px-5 py-2.5 text-white text-sm font-medium hover:bg-indigo-700"
              >
                Return to invoice
              </Link>
            </div>
          )}

          {state === 'error' && (
            <div className="text-center">
              <AlertTriangle className="w-14 h-14 text-amber-500 mx-auto" />
              <h1 className="mt-4 text-2xl font-semibold text-slate-900">We couldn&apos;t verify this payment</h1>
              <p className="mt-2 text-slate-600">{errorMsg}</p>
              <p className="mt-4 text-sm text-slate-500">
                If your account was debited, it will be reflected within a few minutes.
                Contact the sender if the status does not update.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
