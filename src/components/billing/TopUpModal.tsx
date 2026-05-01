/**
 * Top-up modal — shown when a tenant hits 402 or manually clicks "Top up".
 * Fetches active bundles, renders a grid, posts the selected one.
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { Zap, X, Loader2 } from 'lucide-react';

interface Bundle {
  id: string;
  name: string;
  flows: number;
  priceCents: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function TopUpModal({ open, onClose, onSuccess }: Props) {
  const [bundles, setBundles]   = useState<Bundle[]>([]);
  const [loading, setLoading]   = useState(false);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [error, setError]       = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setLoading(true);
    apiFetch('/api/billing/flows/bundles')
      .then((r) => r.json())
      .then((j) => {
        if (j.success === false) throw new Error(j.error?.message ?? 'Failed to load bundles');
        setBundles(j.data as Bundle[]);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed'))
      .finally(() => setLoading(false));
  }, [open]);

  async function buy(bundleId: string) {
    setPurchasing(bundleId);
    setError('');
    try {
      const res = await apiFetch('/api/billing/flows/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundleId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? 'Purchase failed');

      // When Paystack is configured the API returns a checkout URL — redirect
      // the browser to complete payment; the webhook credits the wallet and
      // the return page confirms.
      const data = json?.data as { mode?: 'paystack_transaction' | 'admin_recorded'; checkoutUrl?: string } | undefined;
      if (data?.mode === 'paystack_transaction' && data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }

      // Admin-recorded path (dev / pilot) — wallet already credited.
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Purchase failed');
    } finally {
      setPurchasing(null);
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-xl shadow-xl max-w-2xl w-full p-6 m-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold">Top up Flows</h2>
            <p className="text-sm text-gray-500 mt-1">Pick a bundle — Flows never expire.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="p-3 mb-4 rounded bg-red-500/10 text-red-500 text-sm">{error}</div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-8 text-gray-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading bundles…
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {bundles.map((b) => (
              <button
                key={b.id}
                onClick={() => buy(b.id)}
                disabled={purchasing !== null}
                className="flex flex-col items-center p-4 rounded-lg border-2 border-gray-200 dark:border-gray-700 hover:border-teal-500 transition-colors disabled:opacity-50"
              >
                <Zap className="w-6 h-6 text-teal-500 mb-2" />
                <div className="text-lg font-semibold">{b.flows}</div>
                <div className="text-xs text-gray-500">{b.name}</div>
                <div className="text-sm font-medium mt-2">R{(b.priceCents / 100).toFixed(2)}</div>
                {purchasing === b.id && (
                  <Loader2 className="w-4 h-4 animate-spin mt-2 text-teal-500" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
