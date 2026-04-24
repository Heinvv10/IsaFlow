/**
 * Settings → Billing → Compare Plans
 * Side-by-side cost comparison: current PAYG month-to-date + projection
 * vs a target subscription plan (default: starter).
 *
 * Read-only. No new APIs — reuses /api/billing/flows/wallet and
 * /api/billing/plans.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { AlertCircle, ArrowLeft, Loader2, Check, Zap } from 'lucide-react';

interface Wallet {
  balance: number;
  monthFlowsUsed: number;
  monthResetAt: string;
}

interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monthly_price_cents: number;
  currency: string;
  limits: Record<string, unknown>;
  display_order: number;
}

function daysInMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function daysBetween(from: Date, to: Date) {
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
}

function formatRand(cents: number) {
  return `R${(cents / 100).toFixed(2)}`;
}

export default function ComparePlansPage() {
  const router = useRouter();
  const against = typeof router.query.against === 'string' ? router.query.against : 'starter';

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [plans, setPlans]   = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [notPayg, setNotPayg] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      try {
        const [wRes, pRes] = await Promise.all([
          apiFetch('/api/billing/flows/wallet'),
          apiFetch('/api/billing/plans'),
        ]);

        if (wRes.status === 403) {
          setNotPayg(true);
          return;
        }
        const [wJson, pJson] = await Promise.all([wRes.json(), pRes.json()]);
        if (!wRes.ok) throw new Error(wJson?.error?.message ?? 'Failed to load wallet');
        if (!pRes.ok) throw new Error(pJson?.error?.message ?? 'Failed to load plans');

        setWallet(wJson.data as Wallet);
        setPlans(pJson.data as Plan[]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const comparison = useMemo(() => {
    if (!wallet) return null;
    const targetPlan = plans.find(p => p.code === against) ?? plans.find(p => p.code !== 'payg');
    if (!targetPlan) return null;

    const monthStart = new Date(wallet.monthResetAt);
    const now        = new Date();
    const totalDays  = daysInMonth(now);
    const elapsed    = daysBetween(monthStart, now);
    const projectedFlows = Math.round((wallet.monthFlowsUsed / elapsed) * totalDays);

    // 1 Flow = 10 cents at the Micro bundle rate (R10 / 100 Flows).
    const mtdCents       = wallet.monthFlowsUsed * 10;
    const projectedCents = projectedFlows * 10;
    const starterCents   = targetPlan.monthly_price_cents;
    const breakEvenFlows = Math.ceil(starterCents / 10);

    return {
      targetPlan,
      totalDays,
      elapsed,
      mtdCents,
      projectedFlows,
      projectedCents,
      starterCents,
      breakEvenFlows,
      savingIfSwitch: projectedCents - starterCents,
    };
  }, [wallet, plans, against]);

  if (notPayg) {
    return (
      <AppLayout>
        <div className="p-8 max-w-3xl">
          <h1 className="text-xl font-semibold mb-2">Compare plans</h1>
          <p className="text-gray-600 dark:text-gray-400">
            Plan comparison is only available on the Pay-As-You-Go plan.
          </p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-6 max-w-5xl">
        <Link
          href="/accounting/settings/billing/flows"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 mb-4"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Flows
        </Link>

        <h1 className="text-xl font-semibold mb-1">Compare plans</h1>
        <p className="text-sm text-gray-500 mb-6">
          See how your Pay-As-You-Go spend this month compares to a flat-rate subscription.
        </p>

        {error && (
          <div className="p-3 mb-4 rounded bg-red-500/10 text-red-500 text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-gray-500 py-8">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading…
          </div>
        )}

        {!loading && comparison && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <div className="p-5 rounded-lg border-2 border-teal-500 bg-white dark:bg-gray-900 relative">
                <div className="absolute top-3 right-3 text-xs font-medium text-teal-600 bg-teal-500/10 px-2 py-0.5 rounded">
                  Current
                </div>
                <div className="flex items-center gap-2 mb-3">
                  <Zap className="w-5 h-5 text-teal-500" />
                  <h2 className="font-semibold">Pay-As-You-Go (Flows)</h2>
                </div>
                <div className="text-3xl font-semibold mb-1">{formatRand(comparison.mtdCents)}</div>
                <div className="text-sm text-gray-500 mb-4">
                  {wallet!.monthFlowsUsed} Flows used over {comparison.elapsed}
                  {comparison.elapsed === 1 ? ' day' : ' days'} this month
                </div>
                <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                  <div className="text-xs text-gray-500 uppercase mb-1">Projected month-end</div>
                  <div className="text-xl font-semibold">{formatRand(comparison.projectedCents)}</div>
                  <div className="text-xs text-gray-500">
                    ≈ {comparison.projectedFlows} Flows by day {comparison.totalDays}
                  </div>
                </div>
              </div>

              <div className="p-5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
                <div className="flex items-center gap-2 mb-3">
                  <h2 className="font-semibold">{comparison.targetPlan.name}</h2>
                </div>
                <div className="text-3xl font-semibold mb-1">{formatRand(comparison.starterCents)}</div>
                <div className="text-sm text-gray-500 mb-4">flat per month — unlimited usage</div>
                <div className="pt-4 border-t border-gray-200 dark:border-gray-700 space-y-2">
                  {comparison.targetPlan.description && (
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                      {comparison.targetPlan.description}
                    </p>
                  )}
                  <div className="text-xs text-gray-500 uppercase mb-1">Includes</div>
                  <ul className="text-sm space-y-1">
                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-teal-500" /> Unlimited invoices, bills, journals</li>
                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-teal-500" /> Unlimited reports (TB, P&amp;L, BS, aging, VAT)</li>
                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-teal-500" /> No per-operation charges</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="p-5 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 mb-6">
              <h2 className="text-sm font-semibold mb-3">The maths</h2>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-sm">
                <div className="flex justify-between sm:block">
                  <dt className="text-gray-500">Break-even point</dt>
                  <dd className="font-medium sm:mt-0.5">{comparison.breakEvenFlows} Flows / month</dd>
                </div>
                <div className="flex justify-between sm:block">
                  <dt className="text-gray-500">Projected Flows (this month)</dt>
                  <dd className="font-medium sm:mt-0.5">{comparison.projectedFlows}</dd>
                </div>
                <div className="flex justify-between sm:block">
                  <dt className="text-gray-500">
                    {comparison.savingIfSwitch > 0 ? 'Monthly saving on Starter' : 'Monthly premium on Starter'}
                  </dt>
                  <dd className={`font-medium sm:mt-0.5 ${comparison.savingIfSwitch > 0 ? 'text-teal-600' : 'text-gray-600'}`}>
                    {formatRand(Math.abs(comparison.savingIfSwitch))}
                  </dd>
                </div>
                <div className="flex justify-between sm:block">
                  <dt className="text-gray-500">Days into month</dt>
                  <dd className="font-medium sm:mt-0.5">{comparison.elapsed} of {comparison.totalDays}</dd>
                </div>
              </dl>
              <p className="text-xs text-gray-500 mt-4">
                Projection assumes the current daily burn rate continues.
                Actual usage may vary. Contact your advisor or the admin team
                to switch plans — there is no contract.
              </p>
            </div>

            <div className="text-xs text-gray-500">
              Switching plans is a manual admin step during the v1 pilot.
              Once you decide, ask an admin to move your company to the{' '}
              <strong>{comparison.targetPlan.name}</strong> plan.
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
