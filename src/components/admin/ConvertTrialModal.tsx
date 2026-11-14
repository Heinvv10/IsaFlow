/**
 * ConvertTrialModal — pick a plan and convert a trial company to paid.
 * Used by /admin/trials.
 */
import { useState, useEffect, useId, useRef } from 'react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { Loader2, X } from 'lucide-react';
import { isConvertiblePlanCode } from '@/modules/admin/types/trialPlans';
import { formatDisplayDate } from '@/utils/dateFormat';
import { useFocusTrap } from '@/components/ui/useFocusTrap';

interface Plan {
  id: string;
  name: string;
  code: string;
  monthly_price_cents: number;
  currency: string;
}

interface Props {
  companyId: string;
  companyName: string;
  onClose: () => void;
  onConverted: () => void;
}

interface Converted { firstChargeAt?: string; hasActiveMandate?: boolean }

export function ConvertTrialModal({ companyId, companyName, onClose, onConverted }: Props) {
  const [plans, setPlans]       = useState<Plan[]>([]);
  const [planId, setPlanId]     = useState('');
  const [loading, setLoading]   = useState(true);
  const [working, setWorking]   = useState(false);
  const [error, setError]       = useState('');
  const [done, setDone]         = useState<Converted | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res  = await apiFetch('/api/admin/billing/plans');
        await assertOk(res, 'Could not load plans - try again');
        const json = await res.json() as { data?: Plan[] };
        // Not the internal trial/payg plans, and no plan preselected: the admin picks one.
        setPlans((json.data ?? []).filter((p) => isConvertiblePlanCode(p.code)));
      } catch (err) {
        setPlans([]); setPlanId('');
        setError(apiErrorMessage(err, 'Could not load plans - try again'));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleConvert() {
    if (!planId) return;
    setWorking(true);
    setError('');
    try {
      const res = await apiFetch('/api/admin/trials/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, planId }),
      });
      if (!res.ok) {
        await assertOk(res, 'Could not convert the trial - try again');
      }
      // The list reloads when the admin closes the summary, so it is read first.
      const json = await res.json().catch(() => null) as { data?: Converted } | null;
      setDone(json?.data ?? {});
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not convert the trial - try again'));
    } finally {
      setWorking(false);
    }
  }

  const finish = done ? onConverted : onClose;
  // A real dialog (audit 4.13): focus inside, Tab trapped, Escape closes (not mid-convert), focus back to the opener.
  const boxRef = useRef<HTMLDivElement>(null);
  useFocusTrap(boxRef, true, () => { if (!working) finish(); });
  const titleId = useId();
  const plansLabelId = useId();

  function formatPrice(cents: number, currency: string) {
    return new Intl.NumberFormat('en-ZA', {
      style: 'currency',
      currency: currency || 'ZAR',
      minimumFractionDigits: 0,
    }).format(cents / 100);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div ref={boxRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 id={titleId} className="text-sm font-semibold text-gray-900 dark:text-white">
            Convert to Paid — <span className="text-teal-500">{companyName}</span>
          </h2>
          <button
            onClick={finish}
            disabled={working}
            aria-label="Close"
            className="p-1.5 rounded text-gray-600 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {error && (
            <p className="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
          )}

          {done ? (
            <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
              <p className="font-medium text-green-500">{companyName} is now on a paid plan.</p>
              {done.firstChargeAt && <p>First charge: {formatDisplayDate(done.firstChargeAt)}.</p>}
              {done.hasActiveMandate === true && <p>It will be charged to the active Paystack mandate.</p>}
              {done.hasActiveMandate === false && (
                <p className="text-amber-500 bg-amber-500/10 rounded-lg px-3 py-2">
                  No active mandate: this company will not be billed until one is set up.
                </p>
              )}
            </div>
          ) : loading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="w-5 h-5 animate-spin text-teal-500" />
            </div>
          ) : plans.length === 0 ? (
            <p className="text-sm text-gray-600 dark:text-gray-400 text-center py-4">No plans available</p>
          ) : (
            <div className="space-y-2">
              <p id={plansLabelId} className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Select plan
              </p>
              <div role="radiogroup" aria-labelledby={plansLabelId} className="space-y-2">
                {plans.map((p) => (
                  <label
                    key={p.id}
                    className={[
                      'flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors',
                      planId === p.id
                        ? 'border-teal-500 bg-teal-500/10'
                        : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800',
                    ].join(' ')}
                  >
                    <input
                      type="radio"
                      name="plan"
                      value={p.id}
                      checked={planId === p.id}
                      onChange={() => setPlanId(p.id)}
                      className="text-teal-500"
                    />
                    <span className="flex-1 text-sm text-gray-900 dark:text-white font-medium">
                      {p.name}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {formatPrice(p.monthly_price_cents, p.currency)}/mo
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-200 dark:border-gray-700">
          {done ? (
            <button onClick={finish}
              className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-700 text-white font-medium rounded-lg transition-colors">
              Done
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                disabled={working}
                className="px-4 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleConvert()}
                disabled={working || !planId || loading}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white font-medium rounded-lg transition-colors"
              >
                {working && <Loader2 className="w-4 h-4 animate-spin" />}
                Convert to Paid
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
