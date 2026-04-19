/**
 * Asset Categories Page — IAS 16 + SARS Wear-and-Tear Policy Table
 * Route: /accounting/assets/categories
 */

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Tags, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Category {
  id: string;
  name: string;
  code: string;
  sars_rate: number;
  sars_years: number;
  description: string;
  useful_life_years: number | null;
  residual_pct: number | null;
  tax_life_years: number | null;
  ias16_group: string | null;
  capitalization_threshold: number | null;
  tax_code: string | null;
  depreciation_method: string | null;
}

const fmtPct = (n: number | null) => n != null ? `${(Number(n) * 100).toFixed(0)}%` : '—';
const fmtYrs = (n: number | null) => n != null ? `${n}y` : '—';
const fmtThresh = (n: number | null) => n != null
  ? new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 }).format(n)
  : '—';

const ias16Colors: Record<string, string> = {
  CE: 'bg-blue-500/10 text-blue-400',
  MV: 'bg-teal-500/10 text-teal-400',
  FF: 'bg-purple-500/10 text-purple-400',
  OE: 'bg-amber-500/10 text-amber-400',
  PM: 'bg-orange-500/10 text-orange-400',
  LPPE: 'bg-rose-500/10 text-rose-400',
  OA: 'bg-gray-500/10 text-gray-400',
  LEASE: 'bg-cyan-500/10 text-cyan-400',
};

export default function AssetCategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    apiFetch('/api/accounting/assets-categories', { credentials: 'include' })
      .then(r => r.json())
      .then(j => { setCategories(j.data || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const visible = filter
    ? categories.filter(c =>
        c.name.toLowerCase().includes(filter.toLowerCase()) ||
        c.code.toLowerCase().includes(filter.toLowerCase()) ||
        (c.ias16_group ?? '').toLowerCase().includes(filter.toLowerCase())
      )
    : categories;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/10">
                <Tags className="h-6 w-6 text-purple-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Asset Categories</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  IAS 16 policy + SARS wear-and-tear lives per category
                </p>
              </div>
            </div>
            <input
              type="text"
              placeholder="Filter by name, code or group…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              className="ff-input text-sm w-60"
            />
          </div>
        </div>

        <div className="p-6">
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)] bg-[var(--ff-bg-primary)]/50">
                    <th className="px-4 py-3">Code</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">IAS 16</th>
                    <th className="px-4 py-3 text-right">Policy Life</th>
                    <th className="px-4 py-3 text-right">Residual %</th>
                    <th className="px-4 py-3 text-right">Tax Life (SARS)</th>
                    <th className="px-4 py-3 text-right">SARS Rate</th>
                    <th className="px-4 py-3 text-right">Cap Threshold</th>
                    <th className="px-4 py-3">Method</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && (
                    <tr>
                      <td colSpan={9} className="px-4 py-10 text-center text-[var(--ff-text-tertiary)]">
                        <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Loading categories…
                      </td>
                    </tr>
                  )}
                  {!loading && visible.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)] text-sm">
                        No categories match your filter.
                      </td>
                    </tr>
                  )}
                  {visible.map((c, i) => (
                    <tr
                      key={c.id}
                      className={`border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/40 transition-colors ${i % 2 === 0 ? '' : 'bg-[var(--ff-bg-primary)]/20'}`}
                    >
                      <td className="px-4 py-3 font-mono text-xs font-semibold text-[var(--ff-text-primary)]">{c.code}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{c.name}</td>
                      <td className="px-4 py-3">
                        {c.ias16_group ? (
                          <span className={`text-xs px-2 py-0.5 rounded font-medium ${ias16Colors[c.ias16_group] ?? 'bg-gray-500/10 text-gray-400'}`}>
                            {c.ias16_group}
                          </span>
                        ) : <span className="text-[var(--ff-text-tertiary)]">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-primary)] font-mono text-xs">{fmtYrs(c.useful_life_years)}</td>
                      <td className="px-4 py-3 text-right text-teal-400 font-mono text-xs">{fmtPct(c.residual_pct)}</td>
                      <td className="px-4 py-3 text-right text-amber-400 font-mono text-xs font-semibold">{fmtYrs(c.tax_life_years)}</td>
                      <td className="px-4 py-3 text-right text-purple-400 font-medium">{c.sars_rate}%</td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-secondary)] font-mono text-xs">{fmtThresh(c.capitalization_threshold)}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)] text-xs capitalize">{(c.depreciation_method ?? 'straight_line').replace(/_/g, ' ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-xs text-[var(--ff-text-tertiary)] mt-3">
            Policy life and residual % are used for IAS 16 book depreciation. Tax life is the SARS wear-and-tear period (no residual).
          </p>
        </div>
      </div>
    </AppLayout>
  );
}
