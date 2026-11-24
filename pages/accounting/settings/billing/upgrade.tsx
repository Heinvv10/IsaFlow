/**
 * Settings > Billing > Upgrade from trial (owner only, dark flag `trial_self_serve_upgrade`).
 *
 * The owner picks a plan and authorises a Paystack payment method
 * (POST /api/billing/upgrade/start sends them to Paystack, which returns them
 * to ./upgrade/return). When a payment method is already authorised (the
 * owner closed the tab after paying) the page offers "Confirm upgrade", which
 * calls POST /api/billing/upgrade/convert directly. Plans and prices come from
 * GET /api/billing/upgrade/status; none are written in the copy.
 */

import { useEffect, useState } from 'react';
import Head from 'next/head';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { formatDisplayDate } from '@/utils/dateFormat';
import { formatMoney } from '@/lib/money/formatMoney';
import { AUTH_VERIFICATION_CENTS } from '@/modules/billing/services/mandateVerificationCharge';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

interface UpgradePlan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monthly_price_cents: number;
  currency: string;
}

export interface UpgradeStatus {
  onTrial: boolean;
  trialEndsAt: string | null;
  isPaid: boolean;
  currentPlanId: string | null;
  hasChargeableMandate: boolean;
  hasActiveMandate: boolean;
  plans: UpgradePlan[];
}

type Blocked = 'unavailable' | 'not_owner' | null;

export default function UpgradeFromTrialPage() {
  const [status, setStatus] = useState<UpgradeStatus | null>(null);
  const [blocked, setBlocked] = useState<Blocked>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [planId, setPlanId] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ firstChargeAt: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch('/api/billing/upgrade/status');
        if (res.status === 404) { setBlocked('unavailable'); return; }
        if (res.status === 403) { setBlocked('not_owner'); return; }
        await assertOk(res, 'Could not load your subscription. Please try again.');
        const json = (await res.json()) as { data: UpgradeStatus };
        setStatus(json.data);
        setPlanId(json.data.plans[0]?.id ?? '');
      } catch (err) {
        setStatus(null);
        setPlanId('');
        setError(apiErrorMessage(err, 'Could not load your subscription. Please try again.'));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const authorise = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch('/api/billing/upgrade/start', { method: 'POST', body: JSON.stringify({ planId }) });
      await assertOk(res, 'Could not start the payment authorisation. Please try again.');
      const json = (await res.json()) as { data: { checkoutUrl: string } };
      window.location.assign(json.data.checkoutUrl);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not start the payment authorisation. Please try again.'));
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch('/api/billing/upgrade/convert', { method: 'POST', body: JSON.stringify({ planId }) });
      await assertOk(res, 'Could not complete the upgrade. Please try again.');
      const json = (await res.json()) as { data: { firstChargeAt: string } };
      setDone({ firstChargeAt: json.data.firstChargeAt });
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not complete the upgrade. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppLayout>
      <Head><title>Upgrade from trial | IsaFlow</title></Head>
      <div className="p-6 max-w-3xl">
        <h1 className="text-xl font-semibold mb-1">Upgrade from trial</h1>

        {loading && <Loader2 className="w-6 h-6 animate-spin text-ink-faint mt-6" aria-label="Loading" />}

        {blocked === 'unavailable' && (
          <p className="text-gray-600 dark:text-gray-400 mt-4">Self-serve upgrade is not available for this company yet.</p>
        )}
        {blocked === 'not_owner' && (
          <p className="text-gray-600 dark:text-gray-400 mt-4">Only the company owner can upgrade the subscription.</p>
        )}

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
            <AlertCircle className="w-4 h-4 mt-0.5" /> <span>{error}</span>
          </div>
        )}

        {done && (
          <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-800">
            <CheckCircle2 className="w-5 h-5 inline mr-2" />
            Your company is now on a paid plan. The first monthly charge is due on {formatDisplayDate(done.firstChargeAt)}.
          </div>
        )}

        {status && !done && !status.onTrial && (
          <p className="text-gray-600 dark:text-gray-400 mt-4">
            {status.isPaid ? 'Your company is already on a paid plan.' : 'This company is not on a trial, so it cannot be upgraded here.'}
          </p>
        )}

        {status && !done && status.onTrial && (
          <div className="mt-4">
            <p className="text-sm text-ink-muted mb-4" data-testid="upgrade-charge-copy">
              Choose a plan, then authorise a card with Paystack. When the card is authorised, a small verification charge
              of {formatMoney(AUTH_VERIFICATION_CENTS / 100)} is made. This charge is not refunded.
              You are billed monthly from the day you upgrade.
            </p>
            <fieldset className="space-y-2">
              <legend className="sr-only">Plan</legend>
              {status.plans.map((p) => (
                <label key={p.id} className="flex items-start gap-3 rounded-lg border border-gray-200 dark:border-gray-700 p-3 cursor-pointer">
                  <input type="radio" name="plan" value={p.id} checked={planId === p.id} onChange={() => setPlanId(p.id)} className="mt-1" />
                  <span>
                    <span className="font-medium">{p.name}</span>
                    <span className="ml-2 text-sm text-ink-muted">{formatMoney(p.monthly_price_cents / 100)} per month</span>
                    {p.description && <span className="block text-sm text-ink-muted">{p.description}</span>}
                  </span>
                </label>
              ))}
            </fieldset>
            {status.plans.length === 0 && <p className="text-sm text-ink-muted">No plans are available right now.</p>}

            <div className="mt-6">
              {status.hasChargeableMandate ? (
                <button type="button" onClick={() => void confirm()} disabled={busy || !planId}
                  className="rounded-lg bg-indigo-600 px-5 py-2.5 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                  Confirm upgrade
                </button>
              ) : status.hasActiveMandate ? (
                <p className="text-sm text-ink-muted">Your payment method is still being confirmed. Please check again in a few minutes.</p>
              ) : (
                <button type="button" onClick={() => void authorise()} disabled={busy || !planId}
                  className="rounded-lg bg-indigo-600 px-5 py-2.5 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                  Authorise payment and upgrade
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
