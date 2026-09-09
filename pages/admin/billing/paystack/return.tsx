/**
 * Paystack — admin mandate authorisation return landing.
 * Authenticated route (admin redirect target). Verifies the captured
 * authorization server-side via /api/billing/paystack/mandate/verify.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';
import { CheckCircle2, XCircle, Loader2, AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

type State = 'verifying' | 'active' | 'failed' | 'cancelled' | 'error';

interface VerifyResponse {
  status: 'active' | 'pending' | 'failed';
  mandateId: string | null;
  /** Set when the payment completed but attached to no mandate. */
  failureReason?: string;
  bankName?: string;
  cardLast4?: string;
  cardBrand?: string;
  maxAmountCents?: number;
}

const fmtZAR = (cents: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(cents / 100);

export default function PaystackMandateReturn() {
  const router = useRouter();
  const [state, setState] = useState<State>('verifying');
  const [data, setData] = useState<VerifyResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!router.isReady) return;
    const { ref, reference } = router.query;
    const r = typeof ref === 'string' ? ref
            : typeof reference === 'string' ? reference : '';
    if (!r) {
      setState('error');
      setErrorMsg('Missing reference.');
      return;
    }

    let cancelled = false;
    let attempts = 0;
    const tick = async () => {
      attempts += 1;
      try {
        const res = await apiFetch(
          `/api/billing/paystack/mandate/verify?ref=${encodeURIComponent(r)}`,
        );
        if (!res.ok) throw new Error(`Verify failed (${res.status})`);
        const json = (await res.json()) as { data: VerifyResponse };
        if (cancelled) return;
        setData(json.data);
        if (json.data.status === 'active') setState('active');
        else if (json.data.status === 'failed') setState('failed');
        else if (attempts < 6) setTimeout(tick, 2000);
        else setState('cancelled');
      } catch (err) {
        if (cancelled) return;
        setState('error');
        setErrorMsg(err instanceof Error ? err.message : 'Verify failed');
      }
    };
    void tick();
    return () => { cancelled = true; };
  }, [router.isReady, router.query]);

  return (
    <>
      <Head><title>Mandate — IsaFlow</title></Head>
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          {state === 'verifying' && (
            <div className="text-center">
              <Loader2 className="w-12 h-12 text-indigo-600 mx-auto animate-spin" />
              <h1 className="mt-4 text-xl font-semibold text-slate-900">Confirming authorisation…</h1>
              <p className="mt-2 text-sm text-slate-600">
                We are verifying the authorisation with Paystack.
              </p>
            </div>
          )}

          {state === 'active' && data && (
            <div className="text-center">
              <CheckCircle2 className="w-14 h-14 text-emerald-600 mx-auto" />
              <h1 className="mt-4 text-2xl font-semibold text-slate-900">Mandate active</h1>
              <p className="mt-2 text-slate-600">
                Recurring billing is now enabled.
                {data.cardBrand && data.cardLast4
                  ? ` Card ${data.cardBrand} •••• ${data.cardLast4}.`
                  : data.bankName ? ` Bank: ${data.bankName}.` : ''}
              </p>
              {typeof data.maxAmountCents === 'number' && (
                <p className="mt-1 text-sm text-slate-500">
                  Authorised up to {fmtZAR(data.maxAmountCents)} per debit.
                </p>
              )}
              <Link
                href="/admin/billing"
                className="mt-6 inline-block rounded-lg bg-indigo-600 px-5 py-2.5 text-white text-sm font-medium hover:bg-indigo-700"
              >
                Back to billing
              </Link>
            </div>
          )}

          {state === 'failed' && (
            <div className="text-center">
              <XCircle className="w-14 h-14 text-rose-600 mx-auto" />
              <h1 className="mt-4 text-2xl font-semibold text-slate-900">Authorisation failed</h1>
              <p className="mt-2 text-slate-600">
                {data?.failureReason?.startsWith('authorisation_')
                  ? 'Your card was charged but the mandate could not be activated. Please contact support with this reference before trying again.'
                  : 'The card or bank declined the authorisation. No mandate is in place.'}
              </p>
              <Link
                href="/admin/billing"
                className="mt-6 inline-block rounded-lg bg-indigo-600 px-5 py-2.5 text-white text-sm font-medium hover:bg-indigo-700"
              >
                Try again
              </Link>
            </div>
          )}

          {(state === 'cancelled' || state === 'error') && (
            <div className="text-center">
              <AlertTriangle className="w-14 h-14 text-amber-500 mx-auto" />
              <h1 className="mt-4 text-2xl font-semibold text-slate-900">
                {state === 'cancelled' ? 'Authorisation pending' : 'We couldn’t verify this authorisation'}
              </h1>
              <p className="mt-2 text-slate-600">
                {state === 'error'
                  ? errorMsg
                  : 'Paystack is still confirming. Refresh in a minute or check the billing page.'}
              </p>
              <Link
                href="/admin/billing"
                className="mt-6 inline-block rounded-lg bg-indigo-600 px-5 py-2.5 text-white text-sm font-medium hover:bg-indigo-700"
              >
                Back to billing
              </Link>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
