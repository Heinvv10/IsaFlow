// pages/accounting/afs/pis-score.tsx
// Public Interest Score dashboard — calculate, view, and update PIS inputs

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/ui';
import { apiFetch } from '@/lib/apiFetch';
import {
  Scale, Loader2, AlertCircle, Save, RefreshCw, AlertTriangle, CheckCircle, Info,
} from 'lucide-react';

// ── Types ───────────────────────────────────────────────────────────────────

interface PisBreakdown {
  fiscalYear: number;
  fiscalYearStart: string;
  fiscalYearEnd: string;
  employees: { beginning: number; end: number; average: number; points: number };
  turnover: { amount: number; points: number };
  thirdPartyLiabilities: { amount: number; points: number };
  shareholders: { count: number; points: number };
  totalScore: number;
  allShareholdersAreDirectors: boolean;
  reportingRequirement: string;
  requiredFramework: string;
  requiredCipcFiling: string;
  dataUnavailable: string[];
  calculatedAt: string;
}

// ── Main Page ───────────────────────────────────────────────────────────────

export default function PisScorePage() {
  const [data, setData] = useState<PisBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Editable fields
  const [empBegin, setEmpBegin] = useState(0);
  const [empEnd, setEmpEnd] = useState(0);
  const [shCount, setShCount] = useState(1);
  const [allDirs, setAllDirs] = useState(true);

  const fetchPis = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/afs/pis-score');
      const json = await res.json();
      const d = json.data as PisBreakdown;
      setData(d);
      setEmpBegin(d.employees.beginning);
      setEmpEnd(d.employees.end);
      setShCount(d.shareholders.count);
      setAllDirs(d.allShareholdersAreDirectors);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load PIS score');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPis(); }, [fetchPis]);

  const saveInputs = async () => {
    setSaving(true);
    setError('');
    setSuccessMsg('');
    try {
      await apiFetch('/api/accounting/afs/pis-score', {
        method: 'PUT',
        body: JSON.stringify({
          employeeCountBeginning: empBegin,
          employeeCountEnd: empEnd,
          shareholderCount: shCount,
          allShareholdersAreDirectors: allDirs,
        }),
      });
      setSuccessMsg('PIS inputs saved. Recalculating...');
      await fetchPis();
      setSuccessMsg('PIS score updated successfully.');
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const fmtR = (n: number) =>
    new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 }).format(n);

  return (
    <AppLayout>
      <PageHeader
        title="Public Interest Score"
        subtitle="Regulation 26(2) — Companies Act 71 of 2008"
        icon={Scale}
      />

      {loading && (
        <div className="flex items-center gap-2 py-8 text-zinc-400">
          <Loader2 className="h-5 w-5 animate-spin" /> Calculating PIS score...
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-800 bg-red-900/30 px-4 py-3 text-sm text-red-300">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      )}

      {successMsg && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-green-800 bg-green-900/30 px-4 py-3 text-sm text-green-300">
          <CheckCircle className="h-4 w-4" /> {successMsg}
        </div>
      )}

      {data && !loading && (
        <div className="space-y-6">
          {/* Score Summary Card */}
          <div className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-4xl font-bold text-white">{data.totalScore}</div>
                <div className="text-sm text-zinc-400">Public Interest Score</div>
              </div>
              <div className="text-right">
                <RequirementBadge requirement={data.reportingRequirement} />
                <div className="mt-1 text-xs text-zinc-500">
                  Framework: {data.requiredFramework === 'full_ifrs' ? 'Full IFRS' : 'IFRS for SMEs'}
                </div>
                <div className="text-xs text-zinc-500">
                  CIPC: {data.requiredCipcFiling === 'afs_required' ? 'AFS filing required' : 'FAS only'}
                </div>
              </div>
            </div>

            {/* Score Bar */}
            <div className="mt-4">
              <div className="relative h-4 overflow-hidden rounded-full bg-zinc-700">
                <div
                  className={`h-full rounded-full transition-all ${
                    data.totalScore >= 350 ? 'bg-red-500' :
                    data.totalScore >= 100 ? 'bg-amber-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${Math.min((data.totalScore / 500) * 100, 100)}%` }}
                />
                {/* Threshold markers */}
                <div className="absolute top-0 h-full w-px bg-zinc-400" style={{ left: '20%' }} title="100 — Review threshold" />
                <div className="absolute top-0 h-full w-px bg-zinc-400" style={{ left: '70%' }} title="350 — Audit threshold" />
              </div>
              <div className="mt-1 flex justify-between text-xs text-zinc-500">
                <span>0</span>
                <span className="ml-[18%]">100 (Review)</span>
                <span className="ml-auto mr-[28%]">350 (Audit)</span>
                <span>500+</span>
              </div>
            </div>

            {data.dataUnavailable.length > 0 && (
              <div className="mt-3 flex items-start gap-2 rounded border border-amber-800 bg-amber-900/20 px-3 py-2 text-xs text-amber-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>Employee count appears to be zero — update below for accurate scoring.</span>
              </div>
            )}
          </div>

          {/* Breakdown Table */}
          <div className="rounded-lg border border-zinc-700 bg-zinc-800/50">
            <div className="border-b border-zinc-700 px-4 py-3">
              <h3 className="text-sm font-semibold text-white">Score Breakdown</h3>
              <p className="text-xs text-zinc-400">Fiscal year: {data.fiscalYearStart} to {data.fiscalYearEnd}</p>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-700 text-left text-xs text-zinc-400">
                  <th className="px-4 py-2">Component</th>
                  <th className="px-4 py-2 text-right">Value</th>
                  <th className="px-4 py-2 text-right">Points</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                <tr className="border-b border-zinc-700/50">
                  <td className="px-4 py-2">Employees (average of beginning + end)</td>
                  <td className="px-4 py-2 text-right font-mono">{data.employees.average}</td>
                  <td className="px-4 py-2 text-right font-mono">{data.employees.points}</td>
                </tr>
                <tr className="border-b border-zinc-700/50">
                  <td className="px-4 py-2">Annual turnover / R1 million</td>
                  <td className="px-4 py-2 text-right font-mono">{fmtR(data.turnover.amount)}</td>
                  <td className="px-4 py-2 text-right font-mono">{data.turnover.points}</td>
                </tr>
                <tr className="border-b border-zinc-700/50">
                  <td className="px-4 py-2">Third-party liabilities / R1 million</td>
                  <td className="px-4 py-2 text-right font-mono">{fmtR(data.thirdPartyLiabilities.amount)}</td>
                  <td className="px-4 py-2 text-right font-mono">{data.thirdPartyLiabilities.points}</td>
                </tr>
                <tr className="border-b border-zinc-700/50">
                  <td className="px-4 py-2">Number of shareholders / members</td>
                  <td className="px-4 py-2 text-right font-mono">{data.shareholders.count}</td>
                  <td className="px-4 py-2 text-right font-mono">{data.shareholders.points}</td>
                </tr>
                <tr className="bg-zinc-700/30 font-bold text-white">
                  <td className="px-4 py-2">Total Public Interest Score</td>
                  <td className="px-4 py-2 text-right" />
                  <td className="px-4 py-2 text-right font-mono">{data.totalScore}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Input Fields */}
          <div className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-6">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Update PIS Inputs</h3>
              <div className="flex gap-2">
                <button
                  onClick={fetchPis}
                  disabled={loading}
                  className="flex items-center gap-1 rounded-md border border-zinc-600 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Recalculate
                </button>
                <button
                  onClick={saveInputs}
                  disabled={saving}
                  className="flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Save & Recalculate
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Employees (Beginning)</label>
                <input
                  type="number"
                  min={0}
                  value={empBegin}
                  onChange={(e) => setEmpBegin(Number(e.target.value))}
                  className="w-full rounded-lg border border-zinc-600 bg-zinc-700 px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Employees (End)</label>
                <input
                  type="number"
                  min={0}
                  value={empEnd}
                  onChange={(e) => setEmpEnd(Number(e.target.value))}
                  className="w-full rounded-lg border border-zinc-600 bg-zinc-700 px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Shareholders / Members</label>
                <input
                  type="number"
                  min={1}
                  value={shCount}
                  onChange={(e) => setShCount(Number(e.target.value))}
                  className="w-full rounded-lg border border-zinc-600 bg-zinc-700 px-3 py-2 text-sm text-white"
                />
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={allDirs}
                    onChange={(e) => setAllDirs(e.target.checked)}
                    className="rounded border-zinc-600 bg-zinc-700"
                  />
                  All shareholders are directors
                </label>
              </div>
            </div>

            <div className="mt-4 flex items-start gap-2 rounded border border-zinc-600 bg-zinc-700/30 px-3 py-2 text-xs text-zinc-400">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Turnover and third-party liabilities are calculated automatically from your GL data.
                Employee and shareholder counts must be entered manually. The &quot;all shareholders are
                directors&quot; flag determines whether a voluntary exemption applies when PIS &lt; 100.
              </span>
            </div>
          </div>

          {/* Thresholds Reference */}
          <div className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-6">
            <h3 className="mb-3 text-sm font-semibold text-white">Reporting Thresholds</h3>
            <div className="space-y-2 text-xs text-zinc-400">
              <div className="flex items-center gap-2">
                <span className="inline-block h-3 w-3 rounded-full bg-green-500" />
                <span><strong className="text-zinc-300">PIS &lt; 100:</strong> Accounting officer report sufficient (if all shareholders are directors). Otherwise independent review.</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block h-3 w-3 rounded-full bg-amber-500" />
                <span><strong className="text-zinc-300">PIS 100–349:</strong> Independent review required (ISRE 2400). IFRS for SMEs framework.</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block h-3 w-3 rounded-full bg-red-500" />
                <span><strong className="text-zinc-300">PIS ≥ 350:</strong> Mandatory audit (ISA 700). Full IFRS framework required.</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}

// ── Requirement Badge ───────────────────────────────────────────────────────

function RequirementBadge({ requirement }: { requirement: string }) {
  const config = {
    mandatory_audit: { label: 'Mandatory Audit', color: 'bg-red-600' },
    independent_review: { label: 'Independent Review', color: 'bg-amber-600' },
    voluntary: { label: 'Voluntary (Exempt)', color: 'bg-green-600' },
  }[requirement] ?? { label: requirement, color: 'bg-zinc-600' };

  return (
    <span className={`inline-block rounded-full px-3 py-1 text-xs font-medium text-white ${config.color}`}>
      {config.label}
    </span>
  );
}
