/**
 * Stitch Money — customer invoice payment return landing.
 * Public route; payer has no ISAFlow session. Query params from Stitch:
 *   id, status (complete|closed|failed), externalReference
 * Status is verified server-side — we never trust the URL alone.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';
import { CheckCircle2, XCircle, Loader2, AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

type VerifyState = 'verifying' | 'completed' | 'failed' | 'cancelled' | 'error';

interface VerifyResponse {
  status: 'completed' | 'failed' | 'cancelled' | 'pending';
  amountCents: number;
  invoiceNumber?: string;
  companyName?: string;
  paymentMethod?: string;
}

const fmtZAR = (cents: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(cents / 100);

export default function StitchReturnPage() {
  const router = useRouter();
  const [state, setState] = useState<VerifyState>('verifying');
  const [data, setData] = useState<VerifyResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!router.isReady) return;
    const { id, externalReference } = router.query;
    const ref = typeof externalReference === 'string' ? externalReference
              : typeof id === 'string' ? id : '';
    if (!ref) {
      setState('error');
      setErrorMsg('Missing payment reference.');
      return;
    }

    (async () => {
      try {
        const res = await apiFetch(
          `/api/portal/payments/stitch/verify?ref=${encodeURIComponent(ref)}`,
        );
        if (!res.ok) throw new Error(`Verification failed (${res.status})`);
        const json = (await res.json()) as { data: VerifyResponse };
        const verified = json.data;
        setData(verified);
        if (verified.status === 'completed') setState('completed');
        else if (verified.status === 'failed') setState('failed');
        else if (verified.status === 'cancelled') setState('cancelled');
        else {
          setState('verifying');
          setTimeout(() => router.replace(router.asPath), 3000);
        }
      } catch (err) {
        setState('error');
        setErrorMsg(err instanceof Error ? err.message : 'Verification failed.');
      }
    })();
  }, [router.isReady, router.query, router]);

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
                Thank you. {fmtZAR(data.amountCents)} has been received
                {data.invoiceNumber ? ` against invoice ${data.invoiceNumber}` : ''}.
              </p>
              {data.companyName && (
                <p className="mt-1 text-sm text-slate-500">Paid to {data.companyName}</p>
              )}
              <p className="mt-6 text-xs text-slate-400">
                A receipt has been emailed to you. You can close this window.
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
