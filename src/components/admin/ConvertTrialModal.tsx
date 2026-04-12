/**
 * ConvertTrialModal — pick a plan and convert a trial company to paid.
 * Used by /admin/trials.
 */
import { useState, useEffect } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { Loader2, X } from 'lucide-react';

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

export function ConvertTrialModal({ companyId, companyName, onClose, onConverted }: Props) {
  const [plans, setPlans]       = useState<Plan[]>([]);
  const [planId, setPlanId]     = useState('');
  const [loading, setLoading]   = useState(true);
  const [working, setWorking]   = useState(false);
  const [error, setError]       = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const res  = await apiFetch('/api/admin/billing/plans');
        const json = await res.json() as { data?: Plan[] };
        setPlans(json.data ?? []);
        if (json.data && json.data.length > 0) setPlanId(json.data[0]?.id ?? '');
      } catch {
        setError('Failed to load plans');
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
        const json = await res.json() as { message?: string };
        throw new Error(json.message ?? 'Conversion failed');
      }
      onConverted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Conversion failed');
    } finally {
      setWorking(false);
    }
  }

  function formatPrice(cents: number, currency: string) {
    return new Intl.NumberFormat('en-ZA', {
      style: 'currency',
      currency: currency || 'ZAR',
      minimumFractionDigits: 0,
    }).format(cents / 100);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
            Convert to Paid — <span className="text-teal-500">{companyName}</span>
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {error && (
            <p className="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
          )}

          {loading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="w-5 h-5 animate-spin text-teal-500" />
            </div>
          ) : plans.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">No plans available</p>
          ) : (
            <div className="space-y-2">
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Select Plan
              </label>
              <div className="space-y-2">
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
            className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-teal-600 hover:bg-teal-700 disabled:opacity-40 text-white font-medium rounded-lg transition-colors"
          >
            {working && <Loader2 className="w-4 h-4 animate-spin" />}
            Convert to Paid
          </button>
        </div>
      </div>
    </div>
  );
}
