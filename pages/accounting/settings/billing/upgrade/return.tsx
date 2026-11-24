/**
 * Self-serve upgrade: where Paystack returns the owner after authorising a card
 * (?plan=<plan id>&ref=<reference>, set by POST /api/billing/upgrade/start).
 *
 * It verifies the mandate through the existing POST
 * /api/billing/paystack/mandate/verify (polling while Paystack confirms), and
 * once the mandate is active converts the company with POST
 * /api/billing/upgrade/convert. The convert is idempotent, so a refresh of this
 * page after a successful upgrade answers the same success.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';

type State = 'verifying' | 'converting' | 'done' | 'failed' | 'pending' | 'error';

const UPGRADE_HREF = '/accounting/settings/billing/upgrade';
const POLL_ATTEMPTS = 6;
const POLL_MS = 2000;

export default function UpgradeReturnPage() {
  const router = useRouter();
  const [state, setState] = useState<State>('verifying');
  const [message, setMessage] = useState('');
  const [firstChargeAt, setFirstChargeAt] = useState('');

  useEffect(() => {
    if (!router.isReady) return;
    const { ref, reference, plan } = router.query;
    const r = typeof ref === 'string' ? ref : typeof reference === 'string' ? reference : '';
    const planId = typeof plan === 'string' ? plan : '';
    if (!r || !planId) {
      setState('error');
      setMessage('This link is missing its payment reference. Start the upgrade again from the upgrade page.');
      return;
    }

    let cancelled = false;
    let attempts = 0;

    const convert = async () => {
      setState('converting');
      try {
        const res = await apiFetch('/api/billing/upgrade/convert', { method: 'POST', body: JSON.stringify({ planId }) });
        await assertOk(res, 'Your card is authorised, but the upgrade could not be completed. Please try again from the upgrade page.');
        const json = (await res.json()) as { data: { firstChargeAt: string } };
        if (cancelled) return;
        setFirstChargeAt(json.data.firstChargeAt);
        setState('done');
      } catch (err) {
        if (cancelled) return;
        setState('error');
        setMessage(apiErrorMessage(err, 'Your card is authorised, but the upgrade could not be completed. Please try again from the upgrade page.'));
      }
    };

    const tick = async () => {
      attempts += 1;
      try {
        const res = await apiFetch('/api/billing/paystack/mandate/verify', { method: 'POST', body: JSON.stringify({ ref: r }) });
        await assertOk(res, 'Could not confirm the card authorisation. Please try again.');
        const json = (await res.json()) as { data: { status: 'active' | 'pending' | 'failed'; failureReason?: string } };
        if (cancelled) return;
        if (json.data.status === 'active') { await convert(); return; }
        if (json.data.status === 'failed') {
          setState('failed');
          setMessage(json.data.failureReason?.startsWith('authorisation_')
            ? 'Your card was charged but the authorisation could not be attached. Please contact support with this reference before trying again.'
            : 'The card authorisation was declined. Your company is still on its trial.');
          return;
        }
        if (attempts < POLL_ATTEMPTS) setTimeout(() => void tick(), POLL_MS);
        else setState('pending');
      } catch (err) {
        if (cancelled) return;
        setState('error');
        setMessage(apiErrorMessage(err, 'Could not confirm the card authorisation. Please try again.'));
      }
    };
    void tick();
    return () => { cancelled = true; };
  }, [router.isReady, router.query]);

  return (
    <AppLayout>
      <Head><title>Upgrade from trial | IsaFlow</title></Head>
      <div className="p-6 max-w-md">
        {(state === 'verifying' || state === 'converting') && (
          <div>
            <Loader2 className="w-10 h-10 text-indigo-600 animate-spin" />
            <h1 className="mt-4 text-xl font-semibold">
              {state === 'verifying' ? 'Confirming your card authorisation' : 'Upgrading your subscription'}
            </h1>
          </div>
        )}

        {state === 'done' && (
          <div>
            <CheckCircle2 className="w-12 h-12 text-emerald-600" />
            <h1 className="mt-4 text-xl font-semibold">Your company is upgraded</h1>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              The first monthly charge is due on {new Date(firstChargeAt).toLocaleDateString('en-ZA')}.
            </p>
          </div>
        )}

        {state === 'failed' && (
          <div>
            <XCircle className="w-12 h-12 text-rose-600" />
            <h1 className="mt-4 text-xl font-semibold">Authorisation failed</h1>
            <p className="mt-2 text-gray-600 dark:text-gray-400">{message}</p>
          </div>
        )}

        {(state === 'pending' || state === 'error') && (
          <div>
            <AlertTriangle className="w-12 h-12 text-amber-500" />
            <h1 className="mt-4 text-xl font-semibold">
              {state === 'pending' ? 'Still waiting for Paystack' : 'Something went wrong'}
            </h1>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              {state === 'pending'
                ? 'Paystack is still confirming your card. Check the upgrade page again in a few minutes.'
                : message}
            </p>
          </div>
        )}

        {state !== 'verifying' && state !== 'converting' && (
          <Link href={UPGRADE_HREF} className="mt-6 inline-block rounded-lg bg-indigo-600 px-5 py-2.5 text-white text-sm font-medium hover:bg-indigo-700">
            Back to upgrade
          </Link>
        )}
      </div>
    </AppLayout>
  );
}
