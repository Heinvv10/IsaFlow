/**
 * Loan Portfolio Dashboard
 * Route: /accounting/loans
 * KPI strip + maturity ladder chart + filterable loan list.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { AppLayout } from '@/components/layout/AppLayout';
import { KpiStrip } from '@/components/ui';
import { apiFetch } from '@/lib/apiFetch';
import { Landmark, Plus, Search, TrendingUp, Calendar, Percent, Loader2 } from 'lucide-react';
import { Loan, PortfolioSummary, fmt, fmtDate, PRODUCT_LABELS } from '@/components/loans/types';
import { LoanStatusBadge } from '@/components/loans/LoanStatusBadge';

const LoanMaturityChart = dynamic(() => import('@/components/loans/LoanMaturityChart'), { ssr: false });

interface MaturityBucket { year: string; outstanding: number }

function buildMaturityLadder(loans: Loan[]): MaturityBucket[] {
  const map: Record<string, number> = {};
  for (const loan of loans) {
    if (loan.status !== 'active') continue;
    const end = new Date(loan.startDate);
    end.setMonth(end.getMonth() + loan.termMonths);
    const yr = String(end.getFullYear());
    map[yr] = (map[yr] ?? 0) + loan.principal;
  }
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, outstanding]) => ({ year, outstanding }));
}

const PRODUCTS = ['bond', 'vehicle_finance', 'shareholder_loan', 'inter_company', 'other'];

export default function LoansIndexPage() {
  const [loans, setLoans] = useState<Loan[]>([]);
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [productFilter, setProductFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const [loansRes, summaryRes] = await Promise.all([
      apiFetch('/api/accounting/loans'),
      apiFetch('/api/accounting/loans/portfolio/summary'),
    ]);
    const [loansJson, summaryJson] = await Promise.all([loansRes.json(), summaryRes.json()]);
    setLoans(loansJson.data ?? []);
    setSummary(summaryJson.data ?? null);
    setLoading(false);
  }, []);

   
  useEffect(() => { load(); }, [load]);

  const filtered = loans.filter(l => {
    if (statusFilter && l.status !== statusFilter) return false;
    if (productFilter && l.product !== productFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!(l.reference ?? '').toLowerCase().includes(q) &&
          !(l.product ?? '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const maturity = buildMaturityLadder(loans);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Landmark className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Loan Portfolio</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Amortisation schedules, events &amp; rate curves
                </p>
              </div>
            </div>
            <Link
              href="/accounting/loans/new"
              className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium"
            >
              <Plus className="h-4 w-4" /> New Loan
            </Link>
          </div>
        </div>

        <div className="p-6 space-y-6">
          <KpiStrip items={[
            { label: 'Total Outstanding', value: summary ? fmt(summary.totalOutstanding) : '—', icon: Landmark, tone: 'neutral' },
            { label: 'Weighted Avg Rate', value: summary ? `${Number(summary.weightedAvgRate).toFixed(2)}%` : '—', icon: Percent, tone: 'info' },
            { label: 'Next-12m Interest', value: summary ? fmt(summary.next12mInterest) : '—', icon: TrendingUp, tone: 'warning' },
            { label: 'Current Portion', value: summary ? fmt(summary.totalCurrentPortion) : '—', icon: Calendar, tone: 'danger' },
            { label: 'Active Loans', value: summary ? summary.activeCount : '—', icon: Landmark, tone: 'success' },
          ]} />

          {maturity.length > 0 && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <h2 className="text-sm font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wide mb-4">
                Maturity Ladder — Outstanding by Final Payment Year
              </h2>
              <LoanMaturityChart data={maturity} />
            </div>
          )}

          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input
                type="text"
                placeholder="Search reference or product…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="ff-input pl-9 text-sm w-64"
              />
            </div>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="ff-select text-sm">
              <option value="">All Status</option>
              <option value="active">Active</option>
              <option value="closed">Closed</option>
              <option value="written_off">Written Off</option>
            </select>
            <select value={productFilter} onChange={e => setProductFilter(e.target.value)} className="ff-select text-sm">
              <option value="">All Products</option>
              {PRODUCTS.map(p => <option key={p} value={p}>{PRODUCT_LABELS[p]}</option>)}
            </select>
            <span className="text-sm text-[var(--ff-text-secondary)]">{filtered.length} loan{filtered.length !== 1 ? 's' : ''}</span>
          </div>

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                  <th className="px-4 py-3">Reference</th>
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3 text-right">Principal</th>
                  <th className="px-4 py-3">Rate</th>
                  <th className="px-4 py-3">Start</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Loading…
                    </td>
                  </tr>
                )}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      No loans found.{' '}
                      <Link href="/accounting/loans/new" className="text-teal-400 hover:underline">
                        Create your first loan
                      </Link>
                    </td>
                  </tr>
                )}
                {filtered.map(loan => {
                  const rateDisplay = loan.rateMode === 'FIXED'
                    ? `${loan.fixedRate ?? 0}%`
                    : `Prime ${loan.rateMode === 'PRIME_PLUS' ? '+' : '−'} ${loan.margin}%`;
                  return (
                    <tr key={loan.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                      <td className="px-4 py-3 font-medium text-[var(--ff-text-primary)]">
                        <Link href={`/accounting/loans/${loan.id}`} className="hover:text-teal-400">
                          {loan.reference || loan.id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                        {PRODUCT_LABELS[loan.product ?? ''] || loan.product || '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(loan.principal)}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{rateDisplay}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{fmtDate(loan.startDate)}</td>
                      <td className="px-4 py-3"><LoanStatusBadge status={loan.status} /></td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/accounting/loans/${loan.id}`}
                          className="text-xs text-teal-400 hover:text-teal-300"
                        >
                          View →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
