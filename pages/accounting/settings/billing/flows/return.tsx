/**
 * Paystack payment-link return page.
 *
 * Tenants land here after completing (or cancelling) a Paystack hosted checkout
 * for a Flow bundle top-up.  We poll the purchase-status endpoint until the
 * webhook has confirmed the credit, then redirect to the Flows settings page.
 * On explicit failure we surface the reason and a retry CTA.
 */

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { CheckCircle2, AlertTriangle, Loader2, ArrowRight } from 'lucide-react';

type Status = 'pending' | 'succeeded' | 'failed';

interface PurchaseStatusResponse {
  purchaseId: string;
  status: Status;
  flows: number;
  priceCents: number;
}

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 60_000; // give the webhook 1 minute before surrendering

export default function FlowsReturnPage() {
  const router = useRouter();
  const ref = typeof router.query.ref === 'string' ? router.query.ref : null;

  const [status, setStatus] = useState<Status | 'timeout' | 'error'>('pending');
  const [flows, setFlows] = useState<number | null>(null);
  const [error, setError] = useState('');
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!ref) return;
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    const startedAt = startedAtRef.current;
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await apiFetch(`/api/billing/flows/purchase-status?id=${encodeURIComponent(ref)}`);
        const json = await res.json();
        if (!res.ok) {
          setError(json?.error?.message ?? 'Failed to look up purchase');
          setStatus('error');
          return;
        }
        const body = json.data as PurchaseStatusResponse;
        if (cancelled) return;

        setFlows(body.flows);
        if (body.status === 'succeeded' || body.status === 'failed') {
          setStatus(body.status);
          return;
        }

        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          setStatus('timeout');
          return;
        }

        setTimeout(() => { if (!cancelled) void tick(); }, POLL_INTERVAL_MS);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error');
        setStatus('error');
      }
    };

    void tick();
    return () => { cancelled = true; };
  }, [ref]);

  if (!ref) {
    return (
      <AppLayout>
        <div className="p-8 max-w-md">
          <h1 className="text-lg font-semibold mb-2">Payment reference missing</h1>
          <p className="text-sm text-gray-500">
            Return URL was opened without a purchase reference.{' '}
            <Link href="/accounting/settings/billing/flows" className="underline">Back to Flows</Link>.
          </p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-8 max-w-md mx-auto">
        {status === 'pending' && (
          <div className="text-center">
            <Loader2 className="w-10 h-10 animate-spin mx-auto text-teal-500 mb-4" />
            <h1 className="text-lg font-semibold mb-1">Confirming your payment…</h1>
            <p className="text-sm text-gray-500">
              Paystack is finalising the payment. We&apos;ll credit your wallet
              as soon as we hear back — usually within a few seconds.
            </p>
          </div>
        )}

        {status === 'succeeded' && (
          <div className="text-center">
            <CheckCircle2 className="w-12 h-12 mx-auto text-teal-500 mb-4" />
            <h1 className="text-lg font-semibold mb-1">Payment confirmed</h1>
            <p className="text-sm text-gray-500 mb-6">
              {flows !== null ? `${flows} Flows have been added to your wallet.` : 'Your wallet has been credited.'}
            </p>
            <Link
              href="/accounting/settings/billing/flows"
              className="inline-flex items-center gap-1 px-4 py-2 text-sm bg-teal-600 hover:bg-teal-700 text-white rounded-lg"
            >
              Back to Flows <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        )}

        {status === 'failed' && (
          <div className="text-center">
            <AlertTriangle className="w-12 h-12 mx-auto text-red-500 mb-4" />
            <h1 className="text-lg font-semibold mb-1">Payment not completed</h1>
            <p className="text-sm text-gray-500 mb-6">
              The payment was cancelled or declined. No Flows were charged — feel free to try again.
            </p>
            <Link
              href="/accounting/settings/billing/flows"
              className="inline-flex items-center gap-1 px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg"
            >
              Back to Flows
            </Link>
          </div>
        )}

        {status === 'timeout' && (
          <div className="text-center">
            <AlertTriangle className="w-12 h-12 mx-auto text-amber-500 mb-4" />
            <h1 className="text-lg font-semibold mb-1">Still confirming…</h1>
            <p className="text-sm text-gray-500 mb-6">
              We haven&apos;t heard back from Paystack yet. Your wallet will
              update automatically once we do — refresh the Flows page in a
              minute or two.
            </p>
            <Link
              href="/accounting/settings/billing/flows"
              className="inline-flex items-center gap-1 px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg"
            >
              Back to Flows
            </Link>
          </div>
        )}

        {status === 'error' && (
          <div className="text-center">
            <AlertTriangle className="w-12 h-12 mx-auto text-red-500 mb-4" />
            <h1 className="text-lg font-semibold mb-1">Couldn&apos;t check status</h1>
            <p className="text-sm text-gray-500 mb-6">{error}</p>
            <Link
              href="/accounting/settings/billing/flows"
              className="inline-flex items-center gap-1 px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg"
            >
              Back to Flows
            </Link>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
