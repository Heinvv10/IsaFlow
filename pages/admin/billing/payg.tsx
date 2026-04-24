/**
 * Admin — PAYG Companies
 * Lists every tenant on the Pay-As-You-Go plan with balance, month spend,
 * and nudge level.  Supports inline "Adjust" to credit/debit a wallet.
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { AlertCircle, Loader2, Zap } from 'lucide-react';
import Link from 'next/link';
import { useAdminHref } from '@/hooks/useAdminPrefix';

interface PaygCompany {
  companyId: string;
  companyName: string;
  balance: number;
  autoTopupEnabled: boolean;
  nudgeLevel: 'none' | 'yellow' | 'orange' | 'red';
  monthFlowsUsed: number;
  monthResetAt: string;
  monthDebitedCents: number;
}

const NUDGE_BADGE: Record<PaygCompany['nudgeLevel'], string> = {
  none:   'bg-gray-500/10 text-gray-500',
  yellow: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  orange: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
  red:    'bg-red-500/10 text-red-600 dark:text-red-400',
};

export default function PaygCompaniesPage() {
  const adminHref = useAdminHref();
  const [companies, setCompanies] = useState<PaygCompany[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [search, setSearch]       = useState('');
  const [nudgeFilter, setNudgeFilter] = useState<'' | PaygCompany['nudgeLevel']>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams();
      if (search.trim())    qs.set('search', search.trim());
      if (nudgeFilter)      qs.set('nudgeLevel', nudgeFilter);
      const res = await apiFetch(`/api/admin/billing/payg/companies?${qs.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? 'Failed to load PAYG companies');
      setCompanies(json.data.companies as PaygCompany[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load PAYG companies');
    } finally {
      setLoading(false);
    }
  }, [search, nudgeFilter]);

  useEffect(() => { void load(); }, [load]);

  async function handleAdjust(companyId: string) {
    const raw = window.prompt('How many Flows to adjust? (negative to debit)');
    if (!raw) return;
    const flows = Number(raw);
    if (!Number.isInteger(flows) || flows === 0) {
      window.alert('Adjustment must be a non-zero integer');
      return;
    }
    const reason = window.prompt('Reason for this adjustment (audit log):');
    if (!reason || !reason.trim()) return;

    const res = await apiFetch(`/api/admin/billing/payg/${companyId}/adjust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
      body: JSON.stringify({ flows, reason }),
    });
    const json = await res.json();
    if (!res.ok) {
      window.alert(json?.error?.message ?? 'Adjustment failed');
      return;
    }
    await load();
  }

  return (
    <AdminLayout title="PAYG Tenants">
      <div className="mb-6 flex flex-wrap gap-3 items-center">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search company name..."
          className="px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white"
        />
        <select
          value={nudgeFilter}
          onChange={(e) => setNudgeFilter(e.target.value as typeof nudgeFilter)}
          className="px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white"
        >
          <option value="">All nudge levels</option>
          <option value="none">None</option>
          <option value="yellow">Yellow</option>
          <option value="orange">Orange</option>
          <option value="red">Red</option>
        </select>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-6">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading PAYG tenants…
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-3">Company</th>
                <th className="text-right px-4 py-3">Balance</th>
                <th className="text-right px-4 py-3">Month Flows</th>
                <th className="text-right px-4 py-3">Month Spend</th>
                <th className="text-center px-4 py-3">Nudge</th>
                <th className="text-center px-4 py-3">Auto-topup</th>
                <th className="text-right px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {companies.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-8 text-gray-500">No PAYG tenants yet.</td></tr>
              ) : companies.map((c) => (
                <tr key={c.companyId} className="border-t border-gray-200 dark:border-gray-700">
                  <td className="px-4 py-3">
                    <Link href={adminHref(`/admin/companies/${c.companyId}`)} className="text-teal-600 hover:underline">
                      {c.companyName}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    <Zap className="inline w-3 h-3 mr-1" />{c.balance}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{c.monthFlowsUsed}</td>
                  <td className="px-4 py-3 text-right font-mono">{formatCurrency(c.monthDebitedCents / 100)}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${NUDGE_BADGE[c.nudgeLevel]}`}>
                      {c.nudgeLevel}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">{c.autoTopupEnabled ? '✓' : '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleAdjust(c.companyId)}
                      className="text-xs text-teal-600 hover:text-teal-500"
                    >
                      Adjust
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminLayout>
  );
}
