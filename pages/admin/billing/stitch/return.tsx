/**
 * Stitch Money — subscription mandate authorisation return landing.
 * Authenticated admin flow; signs off a LinkPay mandate that unlocks recurring
 * monthly debits for the tenant's ISAFlow subscription.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { CheckCircle2, XCircle, Loader2, AlertTriangle, ArrowRight } from 'lucide-react';

type MandateState = 'verifying' | 'active' | 'failed' | 'cancelled' | 'error';

interface MandateVerifyResponse {
  status: 'active' | 'failed' | 'cancelled' | 'pending';
  mandateId?: string;
  bankName?: string;
  maskedAccountNumber?: string;
  maxAmountCents?: number;
  nextChargeDate?: string;
}

export default function AdminStitchMandateReturn() {
  const router = useRouter();
  const [state, setState] = useState<MandateState>('verifying');
  const [data, setData] = useState<MandateVerifyResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!router.isReady) return;
    const { id, externalReference } = router.query;
    const ref = typeof externalReference === 'string' ? externalReference
              : typeof id === 'string' ? id : '';
    if (!ref) {
      setState('error');
      setErrorMsg('Missing mandate reference.');
      return;
    }

    (async () => {
      try {
        const res = await apiFetch(
          `/api/billing/stitch/mandate/verify?ref=${encodeURIComponent(ref)}`,
        );
        if (!res.ok) throw new Error(`Verification failed (${res.status})`);
        const json = (await res.json()) as { data: MandateVerifyResponse };
        const verified = json.data;
        setData(verified);
        if (verified.status === 'active') setState('active');
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
    <AdminLayout title="Billing mandate">
      <div className="max-w-2xl mx-auto py-10 px-4">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          {state === 'verifying' && (
            <div className="text-center">
              <Loader2 className="w-12 h-12 text-indigo-600 mx-auto animate-spin" />
              <h1 className="mt-4 text-xl font-semibold text-slate-900">Authorising debit order…</h1>
              <p className="mt-2 text-sm text-slate-600">
                We are confirming the mandate with your bank. This can take up to a minute.
              </p>
            </div>
          )}

          {state === 'active' && data && (
            <div>
              <div className="flex items-start gap-4">
                <CheckCircle2 className="w-12 h-12 text-emerald-600 shrink-0" />
                <div>
                  <h1 className="text-2xl font-semibold text-slate-900">Debit order active</h1>
                  <p className="mt-1 text-slate-600">
                    Your ISAFlow subscription will now be debited automatically each month.
                  </p>
                </div>
              </div>

              <div className="mt-6 border-t border-slate-200 pt-6 space-y-3">
                {data.bankName && (
                  <Row label="Bank" value={data.bankName} />
                )}
                {data.maskedAccountNumber && (
                  <Row label="Account" value={data.maskedAccountNumber} />
                )}
                {typeof data.maxAmountCents === 'number' && (
                  <Row label="Authorised up to" value={formatCurrency(data.maxAmountCents / 100)} />
                )}
                {data.nextChargeDate && (
                  <Row label="First debit" value={new Date(data.nextChargeDate).toLocaleDateString('en-ZA')} />
                )}
              </div>

              <div className="mt-8 flex items-center justify-end gap-3">
                <Link
                  href="/admin/billing"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-5 py-2.5 text-white text-sm font-medium hover:bg-indigo-700"
                >
                  Go to billing <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            </div>
          )}

          {state === 'failed' && (
            <div className="text-center">
              <XCircle className="w-14 h-14 text-rose-600 mx-auto" />
              <h1 className="mt-4 text-2xl font-semibold text-slate-900">Authorisation failed</h1>
              <p className="mt-2 text-slate-600">
                Your bank rejected the mandate. No charges have been made.
              </p>
              <Link
                href="/admin/billing"
                className="mt-6 inline-block rounded-lg bg-indigo-600 px-5 py-2.5 text-white text-sm font-medium hover:bg-indigo-700"
              >
                Try again
              </Link>
            </div>
          )}

          {state === 'cancelled' && (
            <div className="text-center">
              <AlertTriangle className="w-14 h-14 text-amber-500 mx-auto" />
              <h1 className="mt-4 text-2xl font-semibold text-slate-900">Authorisation cancelled</h1>
              <p className="mt-2 text-slate-600">
                You cancelled before signing off the debit order. No charges have been made.
              </p>
              <Link
                href="/admin/billing"
                className="mt-6 inline-block rounded-lg bg-indigo-600 px-5 py-2.5 text-white text-sm font-medium hover:bg-indigo-700"
              >
                Back to billing
              </Link>
            </div>
          )}

          {state === 'error' && (
            <div className="text-center">
              <AlertTriangle className="w-14 h-14 text-amber-500 mx-auto" />
              <h1 className="mt-4 text-2xl font-semibold text-slate-900">We couldn&apos;t confirm the mandate</h1>
              <p className="mt-2 text-slate-600">{errorMsg}</p>
              <p className="mt-4 text-sm text-slate-500">
                The authorisation may still complete shortly. Refresh this page in a minute, or contact support.
              </p>
            </div>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-900">{value}</span>
    </div>
  );
}
