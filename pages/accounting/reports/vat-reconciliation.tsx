// pages/accounting/reports/vat-reconciliation.tsx
// VAT Reconciliation — monthly GL vs invoices vs submitted returns

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/ui';
import { apiFetch } from '@/lib/apiFetch';
import {
  FileSearch, Loader2, AlertCircle, AlertTriangle, CheckCircle, TrendingUp,
} from 'lucide-react';

// ── Types ───────────────────────────────────────────────────────────────────

interface VatReconMonth {
  month: string;
  glRevenue: number;
  glOutputVat: number;
  glInputVat: number;
  glNetVat: number;
  invoiceRevenue: number;
  returnOutputVat: number | null;
  returnInputVat: number | null;
  returnNetVat: number | null;
  returnStatus: string | null;
  capitalGoodsOutput: number;
  capitalGoodsInput: number;
  otherGoodsOutput: number;
  otherGoodsInput: number;
  revenueVariance: number;
  outputVatVariance: number;
  inputVatVariance: number;
  effectiveVatRate: number;
}

interface VatReconData {
  type: 'reconciliation';
  months: VatReconMonth[];
  totals: {
    glRevenue: number;
    glOutputVat: number;
    glInputVat: number;
    glNetVat: number;
    invoiceRevenue: number;
    returnNetVat: number;
    capitalGoodsOutput: number;
    capitalGoodsInput: number;
    revenueVariance: number;
    outputVatVariance: number;
    inputVatVariance: number;
  };
  issues: Array<{ month: string; severity: string; message: string }>;
}

interface VatYearSummary {
  year: number;
  totalOutputVat: number;
  totalInputVat: number;
  netVat: number;
  totalRevenue: number;
  effectiveRate: number;
  returnsSubmitted: number;
  returnsExpected: number;
}

interface MultiYearData {
  type: 'multi_year';
  summary: VatYearSummary[];
}

type ViewMode = 'reconciliation' | 'multi_year';

// ── Helpers ─────────────────────────────────────────────────────────────────

const fmtR = (n: number | null) =>
  n == null ? '—' : new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

const fmtMonth = (m: string) => {
  const [y, mo] = m.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(mo) - 1]} ${y}`;
};

// ── Main Page ───────────────────────────────────────────────────────────────

export default function VatReconciliationPage() {
  const [mode, setMode] = useState<ViewMode>('reconciliation');
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 11);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  });
  const [to, setTo] = useState(() => {
    const d = new Date();
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${lastDay}`;
  });
  const [reconData, setReconData] = useState<VatReconData | null>(null);
  const [multiData, setMultiData] = useState<MultiYearData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const url = mode === 'multi_year'
        ? '/api/accounting/vat-reconciliation?multi_year=3'
        : `/api/accounting/vat-reconciliation?from=${from}&to=${to}`;
      const res = await apiFetch(url);
      const json = await res.json();
      if (mode === 'multi_year') {
        setMultiData(json.data);
      } else {
        setReconData(json.data);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [mode, from, to]);

  useEffect(() => { fetchData(); }, [fetchData]);

  return (
    <AppLayout>
      <PageHeader
        title="VAT Reconciliation"
        subtitle="GL vs Invoices vs Submitted Returns"
        icon={FileSearch}
      />

      {/* Controls */}
      <div className="mb-6 flex flex-wrap items-end gap-4">
        <div>
          <label className="mb-1 block text-xs text-zinc-400">View</label>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as ViewMode)}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white"
          >
            <option value="reconciliation">Monthly Reconciliation</option>
            <option value="multi_year">Multi-Year Summary</option>
          </select>
        </div>
        {mode === 'reconciliation' && (
          <>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">From</label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">To</label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white"
              />
            </div>
          </>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-8 text-zinc-400">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading...
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-800 bg-red-900/30 px-4 py-3 text-sm text-red-300">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      )}

      {/* Monthly Reconciliation */}
      {mode === 'reconciliation' && reconData && !loading && (
        <div className="space-y-6">
          {/* Issues */}
          {reconData.issues.length > 0 && (
            <div className="space-y-2">
              {reconData.issues.map((issue, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-2 rounded-lg border px-4 py-2 text-xs ${
                    issue.severity === 'error'
                      ? 'border-red-800 bg-red-900/20 text-red-300'
                      : 'border-amber-800 bg-amber-900/20 text-amber-300'
                  }`}
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span><strong>{fmtMonth(issue.month)}:</strong> {issue.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* Main Table */}
          <div className="overflow-x-auto rounded-lg border border-zinc-700">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-700 bg-zinc-800 text-left text-zinc-400">
                  <th className="px-3 py-2">Month</th>
                  <th className="px-3 py-2 text-right">GL Revenue</th>
                  <th className="px-3 py-2 text-right">GL Output VAT</th>
                  <th className="px-3 py-2 text-right">GL Input VAT</th>
                  <th className="px-3 py-2 text-right">GL Net VAT</th>
                  <th className="px-3 py-2 text-right">Return Net VAT</th>
                  <th className="px-3 py-2 text-right">Revenue Var.</th>
                  <th className="px-3 py-2 text-right">Eff. Rate</th>
                  <th className="px-3 py-2 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {reconData.months.map((m) => (
                  <tr key={m.month} className="border-b border-zinc-700/50 hover:bg-zinc-800/50">
                    <td className="px-3 py-2 font-medium">{fmtMonth(m.month)}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmtR(m.glRevenue)}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmtR(m.glOutputVat)}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmtR(m.glInputVat)}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold">{fmtR(m.glNetVat)}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmtR(m.returnNetVat)}</td>
                    <td className={`px-3 py-2 text-right font-mono ${Math.abs(m.revenueVariance) > 100 ? 'text-amber-400' : ''}`}>
                      {fmtR(m.revenueVariance)}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${
                      m.effectiveVatRate > 0 && (m.effectiveVatRate < 13 || m.effectiveVatRate > 17) ? 'text-amber-400' : ''
                    }`}>
                      {m.effectiveVatRate > 0 ? `${m.effectiveVatRate}%` : '—'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {m.returnStatus === 'submitted' ? (
                        <CheckCircle className="mx-auto h-4 w-4 text-green-400" />
                      ) : (
                        <span className="text-zinc-500">—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {/* Totals row */}
                <tr className="border-t-2 border-zinc-600 bg-zinc-800 font-bold text-white">
                  <td className="px-3 py-2">Total</td>
                  <td className="px-3 py-2 text-right font-mono">{fmtR(reconData.totals.glRevenue)}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmtR(reconData.totals.glOutputVat)}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmtR(reconData.totals.glInputVat)}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmtR(reconData.totals.glNetVat)}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmtR(reconData.totals.returnNetVat)}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmtR(reconData.totals.revenueVariance)}</td>
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2" />
                </tr>
              </tbody>
            </table>
          </div>

          {/* Capital Goods Split */}
          <div className="rounded-lg border border-zinc-700 bg-zinc-800/50">
            <div className="border-b border-zinc-700 px-4 py-3">
              <h3 className="text-sm font-semibold text-white">Capital Goods vs Other Goods Split</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-700 text-left text-zinc-400">
                    <th className="px-3 py-2">Month</th>
                    <th className="px-3 py-2 text-right">Capital Output</th>
                    <th className="px-3 py-2 text-right">Capital Input</th>
                    <th className="px-3 py-2 text-right">Other Output</th>
                    <th className="px-3 py-2 text-right">Other Input</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-300">
                  {reconData.months.map((m) => (
                    <tr key={m.month} className="border-b border-zinc-700/50">
                      <td className="px-3 py-2">{fmtMonth(m.month)}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmtR(m.capitalGoodsOutput)}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmtR(m.capitalGoodsInput)}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmtR(m.otherGoodsOutput)}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmtR(m.otherGoodsInput)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Multi-Year Summary */}
      {mode === 'multi_year' && multiData && !loading && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-800/50">
          <div className="border-b border-zinc-700 px-4 py-3 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-zinc-400" />
            <h3 className="text-sm font-semibold text-white">Multi-Year VAT Summary</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-700 text-left text-xs text-zinc-400">
                  <th className="px-4 py-2">Year</th>
                  <th className="px-4 py-2 text-right">Revenue</th>
                  <th className="px-4 py-2 text-right">Output VAT</th>
                  <th className="px-4 py-2 text-right">Input VAT</th>
                  <th className="px-4 py-2 text-right">Net VAT</th>
                  <th className="px-4 py-2 text-right">Eff. Rate</th>
                  <th className="px-4 py-2 text-center">Returns</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {multiData.summary.map((y) => (
                  <tr key={y.year} className="border-b border-zinc-700/50">
                    <td className="px-4 py-2 font-medium">{y.year}</td>
                    <td className="px-4 py-2 text-right font-mono">{fmtR(y.totalRevenue)}</td>
                    <td className="px-4 py-2 text-right font-mono">{fmtR(y.totalOutputVat)}</td>
                    <td className="px-4 py-2 text-right font-mono">{fmtR(y.totalInputVat)}</td>
                    <td className="px-4 py-2 text-right font-mono font-semibold">{fmtR(y.netVat)}</td>
                    <td className="px-4 py-2 text-right font-mono">{y.effectiveRate}%</td>
                    <td className="px-4 py-2 text-center">
                      <span className={y.returnsSubmitted < y.returnsExpected ? 'text-amber-400' : 'text-green-400'}>
                        {y.returnsSubmitted}/{y.returnsExpected}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
