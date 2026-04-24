/**
 * FlowWalletWidget — compact dashboard widget showing Flow balance, nudge,
 * and a "Top up" button.  Hidden for non-PAYG tenants (relies on the
 * wallet endpoint returning 403).
 */

import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { Zap, Plus, Loader2 } from 'lucide-react';
import { TopUpModal } from './TopUpModal';
import { UpgradeNudgeBanner, type NudgeLevel } from './UpgradeNudgeBanner';

interface WalletResp {
  balance: number;
  nudgeLevel: NudgeLevel;
  monthFlowsUsed: number;
}

export function FlowWalletWidget() {
  const [wallet, setWallet] = useState<WalletResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [show403, setShow403] = useState(false);
  const [showModal, setShowModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/billing/flows/wallet');
      if (res.status === 403) {
        setShow403(true);
        return;
      }
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? 'Failed');
      setWallet(json.data as WalletResp);
    } catch {
      // Silent — widget just won't render
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Non-PAYG tenants see nothing.
  if (show403) return null;

  return (
    <>
      <UpgradeNudgeBanner level={wallet?.nudgeLevel ?? 'none'} monthFlowsUsed={wallet?.monthFlowsUsed ?? 0} />

      <div className="flex items-center justify-between p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-teal-500/10">
            <Zap className="w-5 h-5 text-teal-500" />
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wide">Flow balance</div>
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin mt-1" />
            ) : (
              <div className="text-2xl font-semibold">{wallet?.balance ?? 0}</div>
            )}
            <div className="text-xs text-gray-500 mt-0.5">
              {wallet?.monthFlowsUsed ?? 0} used this month
            </div>
          </div>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="inline-flex items-center gap-1 px-3 py-2 text-sm bg-teal-600 hover:bg-teal-700 text-white rounded-lg"
        >
          <Plus className="w-4 h-4" /> Top up
        </button>
      </div>

      <TopUpModal open={showModal} onClose={() => setShowModal(false)} onSuccess={load} />
    </>
  );
}
