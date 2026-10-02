/**
 * FlowWalletWidget — compact dashboard widget showing Flow balance, nudge,
 * and a "Top up" button.  Hidden for non-PAYG tenants (relies on the
 * wallet endpoint returning 403).
 */

import { useEffect, useState, useCallback } from 'react';
import { apiFetch, assertOk } from '@/lib/apiFetch';
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
  const [failed, setFailed] = useState(false);
  const [show403, setShow403] = useState(false);
  const [showModal, setShowModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setFailed(false);
    try {
      const res = await apiFetch('/api/billing/flows/wallet');
      if (res.status === 403) {
        setShow403(true);
        return;
      }
      await assertOk(res, 'Could not load the Flow balance - try again');
      const json = await res.json();
      setWallet(json.data as WalletResp);
    } catch {
      setWallet(null); setFailed(true); // never show a made-up zero balance
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
            ) : failed ? (
              <div className="text-sm text-red-500 mt-1">Could not load the Flow balance - try again</div>
            ) : (
              <div className="text-2xl font-semibold">{wallet?.balance ?? 0}</div>
            )}
            {!failed && <div className="text-xs text-gray-500 mt-0.5">
              {wallet?.monthFlowsUsed ?? 0} used this month
            </div>}
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
