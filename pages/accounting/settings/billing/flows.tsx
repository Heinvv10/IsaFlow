/**
 * Settings → Billing → Flows
 * Tenant wallet page: balance, bundle selector, auto-topup toggle,
 * paginated ledger history.
 */

import { useEffect, useState, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { TopUpModal } from '@/components/billing/TopUpModal';
import { UpgradeNudgeBanner, type NudgeLevel } from '@/components/billing/UpgradeNudgeBanner';
import { Zap, Plus, AlertCircle, Loader2 } from 'lucide-react';

interface Wallet {
  balance: number;
  nudgeLevel: NudgeLevel;
  monthFlowsUsed: number;
  autoTopupEnabled: boolean;
  autoTopupBundleId: string | null;
}

interface Bundle {
  id: string;
  name: string;
  flows: number;
  priceCents: number;
}

interface LedgerEntry {
  id: string;
  type: 'purchase' | 'debit' | 'refund' | 'admin_adjustment';
  flows: number;
  balanceAfter: number;
  operationCode: string | null;
  reason: string | null;
  createdAt: string;
}

export default function FlowsSettingsPage() {
  const [wallet, setWallet]   = useState<Wallet | null>(null);
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [ledger, setLedger]   = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [notPayg, setNotPayg] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [wRes, bRes, lRes] = await Promise.all([
        apiFetch('/api/billing/flows/wallet'),
        apiFetch('/api/billing/flows/bundles'),
        apiFetch('/api/billing/flows/ledger?limit=50'),
      ]);

      if (wRes.status === 403) {
        setNotPayg(true);
        return;
      }

      const [wJson, bJson, lJson] = await Promise.all([wRes.json(), bRes.json(), lRes.json()]);
      if (!wRes.ok) throw new Error(wJson?.error?.message ?? 'Failed to load wallet');
      setWallet(wJson.data as Wallet);
      setBundles(bJson.data as Bundle[]);
      setLedger(lJson.data.entries as LedgerEntry[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function updateAutoTopup(enabled: boolean, bundleId: string | null) {
    const res = await apiFetch('/api/billing/flows/auto-topup', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, bundleId }),
    });
    if (res.ok) await load();
  }

  if (notPayg) {
    return (
      <AppLayout>
        <div className="p-8 max-w-3xl">
          <h1 className="text-xl font-semibold mb-2">Flows</h1>
          <p className="text-gray-600 dark:text-gray-400">
            Flows are the prepaid usage credits on the Pay-As-You-Go plan.
            Your company is on a subscription plan, so this page doesn&apos;t apply.
          </p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-6 max-w-5xl">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 rounded-lg bg-teal-500/10">
            <Zap className="w-6 h-6 text-teal-500" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Flows</h1>
            <p className="text-sm text-gray-500">Prepaid usage credits for your Pay-As-You-Go plan.</p>
          </div>
        </div>

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

        {!loading && wallet && (
          <>
            <UpgradeNudgeBanner level={wallet.nudgeLevel} monthFlowsUsed={wallet.monthFlowsUsed} />

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <div className="p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
                <div className="text-xs text-gray-500 uppercase mb-1">Balance</div>
                <div className="text-3xl font-semibold">{wallet.balance}</div>
                <div className="text-xs text-gray-500">Flows available</div>
              </div>
              <div className="p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
                <div className="text-xs text-gray-500 uppercase mb-1">Used this month</div>
                <div className="text-3xl font-semibold">{wallet.monthFlowsUsed}</div>
                <div className="text-xs text-gray-500">
                  ≈ R{((wallet.monthFlowsUsed * 10) / 100).toFixed(2)}
                </div>
              </div>
              <div className="p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex items-center justify-between">
                <div>
                  <div className="text-xs text-gray-500 uppercase mb-1">Top up</div>
                  <div className="text-sm text-gray-500">Buy a bundle now</div>
                </div>
                <button
                  onClick={() => setModalOpen(true)}
                  className="inline-flex items-center gap-1 px-3 py-2 text-sm bg-teal-600 hover:bg-teal-700 text-white rounded-lg"
                >
                  <Plus className="w-4 h-4" /> Top up
                </button>
              </div>
            </div>

            <div className="p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 mb-6">
              <h2 className="text-sm font-semibold mb-3">Auto top-up</h2>
              <div className="text-sm text-gray-500 mb-3">
                When enabled, we automatically purchase a bundle when your balance hits zero.
                <br />
                <span className="text-xs">
                  (v1: payment gateway is not yet integrated — this will succeed once a payment method is on file.)
                </span>
              </div>
              <label className="flex items-center gap-3 mb-3">
                <input
                  type="checkbox"
                  checked={wallet.autoTopupEnabled}
                  onChange={(e) => updateAutoTopup(e.target.checked, wallet.autoTopupBundleId)}
                />
                <span className="text-sm">Enable auto top-up</span>
              </label>
              {wallet.autoTopupEnabled && (
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Bundle to purchase</label>
                  <select
                    value={wallet.autoTopupBundleId ?? ''}
                    onChange={(e) => updateAutoTopup(true, e.target.value || null)}
                    className="px-3 py-2 text-sm rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
                  >
                    <option value="">Select bundle...</option>
                    {bundles.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} — {b.flows} Flows @ R{(b.priceCents / 100).toFixed(2)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                <h2 className="text-sm font-semibold">Ledger</h2>
              </div>
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-gray-500">
                  <tr>
                    <th className="text-left px-4 py-2">When</th>
                    <th className="text-left px-4 py-2">Type</th>
                    <th className="text-left px-4 py-2">Operation</th>
                    <th className="text-right px-4 py-2">Flows</th>
                    <th className="text-right px-4 py-2">Balance after</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.length === 0 ? (
                    <tr><td colSpan={5} className="text-center py-8 text-gray-500">No ledger entries yet.</td></tr>
                  ) : ledger.map((l) => (
                    <tr key={l.id} className="border-t border-gray-200 dark:border-gray-700">
                      <td className="px-4 py-2 text-gray-500">
                        {new Date(l.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-2">{l.type}</td>
                      <td className="px-4 py-2 text-gray-500">{l.operationCode ?? l.reason ?? '—'}</td>
                      <td className={`px-4 py-2 text-right font-mono ${l.flows > 0 ? 'text-teal-600' : 'text-red-500'}`}>
                        {l.flows > 0 ? `+${l.flows}` : l.flows}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">{l.balanceAfter}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <TopUpModal open={modalOpen} onClose={() => setModalOpen(false)} onSuccess={load} />
      </div>
    </AppLayout>
  );
}
