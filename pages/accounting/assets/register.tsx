/**
 * Asset Register Report Page
 * Full asset register with date filter and summary totals.
 * Route: /accounting/assets/register
 */

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { FileText, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { ExportCSVButton } from '@/components/shared/ExportCSVButton';

interface Asset {
  id: string;
  asset_number: string;
  name: string;
  category: string;
  category_name: string;
  purchase_date: string;
  purchase_price: number;
  total_depreciation: number;
  net_book_value: number;
  depreciation_method: string;
  status: string;
  sars_rate: number;
}

interface Summary {
  totalAssets: number;
  totalCost: number;
  totalAccumulatedDepreciation: number;
  totalBookValue: number;
  asOfDate: string;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

export default function AssetRegisterPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [asOf, setAsOf] = useState(new Date().toISOString().split('T')[0]!);

  useEffect(() => {
    setLoading(true);
    apiFetch(`/api/accounting/assets-register?asOf=${asOf}`, { credentials: 'include' })
      .then(r => r.json())
      .then(j => {
        setAssets(j.data?.assets || []);
        setSummary(j.data?.summary || null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [asOf]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <FileText className="h-6 w-6 text-blue-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Asset Register</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Complete fixed asset register with depreciation summary
                </p>
              </div>
            </div>
            <ExportCSVButton endpoint={`/api/accounting/assets-register?asOf=${asOf}&format=csv`} filenamePrefix="asset-register" label="Export CSV" />
          </div>
        </div>

        <div className="p-6 space-y-4">
          <div className="flex items-center gap-3">
            <label className="text-sm text-[var(--ff-text-secondary)]">As of:</label>
            <input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} className="ff-input text-sm" />
          </div>

          {/* Summary */}
          {summary && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)]">Total Assets</p>
                <p className="text-xl font-bold text-[var(--ff-text-primary)]">{summary.totalAssets}</p>
              </div>
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)]">Total Cost</p>
                <p className="text-xl font-bold text-[var(--ff-text-primary)]">{fmt(summary.totalCost)}</p>
              </div>
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)]">Total Accumulated Depreciation</p>
                <p className="text-xl font-bold text-purple-400">{fmt(summary.totalAccumulatedDepreciation)}</p>
              </div>
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)]">Total Book Value</p>
                <p className="text-xl font-bold text-teal-400">{fmt(summary.totalBookValue)}</p>
              </div>
            </div>
          )}

          {/* Table */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                  <th className="px-4 py-3">Asset #</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Purchase Date</th>
                  <th className="px-4 py-3 text-right">Cost</th>
                  <th className="px-4 py-3 text-right">Accum. Dep.</th>
                  <th className="px-4 py-3 text-right">Book Value</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Loading...
                    </td>
                  </tr>
                )}
                {!loading && assets.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      No assets found for this period
                    </td>
                  </tr>
                )}
                {assets.map(a => (
                  <tr key={a.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                    <td className="px-4 py-3 font-medium text-[var(--ff-text-primary)]">{a.asset_number}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{a.name}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{a.category_name || a.category}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{a.purchase_date}</td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(Number(a.purchase_price))}</td>
                    <td className="px-4 py-3 text-right text-purple-400">{fmt(Number(a.total_depreciation))}</td>
                    <td className="px-4 py-3 text-right text-teal-400 font-medium">{fmt(Number(a.net_book_value))}</td>
                    <td className="px-4 py-3 capitalize text-xs text-[var(--ff-text-secondary)]">{(a.status || '').replace(/_/g, ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
