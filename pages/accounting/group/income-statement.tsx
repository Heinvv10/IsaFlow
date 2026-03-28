/**
 * Consolidated Income Statement Page
 * Multi-entity P&L with elimination entries and consolidated totals.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { BarChart3, Loader2, AlertCircle, Download, Building2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface EntityAmount {
  amount: number;
}

interface ConsolidatedISRow {
  groupAccountCode: string;
  groupAccountName: string;
  section: 'revenue' | 'cost_of_sales' | 'operating_expenses';
  entities: { [companyId: string]: EntityAmount };
  elimination: number;
  consolidated: number;
}

interface SectionTotals {
  entities: { [companyId: string]: number };
  elimination: number;
  consolidated: number;
}

interface ConsolidatedISResponse {
  rows: ConsolidatedISRow[];
  entityNames: { [companyId: string]: string };
  totalRevenue: SectionTotals;
  totalCostOfSales: SectionTotals;
  grossProfit: SectionTotals;
  totalOperatingExpenses: SectionTotals;
  netProfit: SectionTotals;
}

interface EntityGroup {
  id: string;
  name: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const today = new Date();
const defaultPeriodStart = `${today.getFullYear()}-01-01`;
const defaultPeriodEnd = today.toISOString().substring(0, 10);

const selectClass =
  'px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm';
const inputClass = selectClass;

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function ConsolidatedIncomeStatementPage() {
  const [groups, setGroups] = useState<EntityGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [periodStart, setPeriodStart] = useState(defaultPeriodStart);
  const [periodEnd, setPeriodEnd] = useState(defaultPeriodEnd);

  const [data, setData] = useState<ConsolidatedISResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  /* ---------- Load available groups ---------- */
  useEffect(() => {
    apiFetch('/api/accounting/company-groups')
      .then(r => r.json())
      .then(json => {
        const items: EntityGroup[] = json.data?.items || json.data?.groups || json.data || [];
        setGroups(items);
        if (items.length > 0 && !selectedGroupId && items[0]) {
          setSelectedGroupId(items[0].id);
        }
      })
      .catch(() => {
        // Non-critical — group list load failure
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Load consolidated income statement ---------- */
  const loadData = useCallback(async () => {
    if (!selectedGroupId) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        group_id: selectedGroupId,
        action: 'income-statement',
        period_start: periodStart,
        period_end: periodEnd,
      });
      const res = await apiFetch(`/api/accounting/consolidated-reports?${params}`);
      if (!res.ok) throw new Error('Failed to load consolidated income statement');
      const json = await res.json();
      const payload: ConsolidatedISResponse = json.data || json;
      setData(payload);
    } catch {
      setError('Failed to load consolidated income statement');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [selectedGroupId, periodStart, periodEnd]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  /* ---------- Derived values ---------- */
  const entityIds = useMemo(() => {
    if (!data) return [];
    return Object.keys(data.entityNames).sort((a, b) =>
      (data.entityNames[a] || '').localeCompare(data.entityNames[b] || ''),
    );
  }, [data]);

  const revenueRows = useMemo(() => data?.rows.filter(r => r.section === 'revenue') || [], [data]);
  const cosRows = useMemo(() => data?.rows.filter(r => r.section === 'cost_of_sales') || [], [data]);
  const opexRows = useMemo(() => data?.rows.filter(r => r.section === 'operating_expenses') || [], [data]);

  /* ---------- CSV Export ---------- */
  const handleExport = useCallback(() => {
    if (!data || data.rows.length === 0) return;

    const headerCols = ['Group Account Code', 'Account Name', 'Section'];
    entityIds.forEach(eid => {
      headerCols.push(data.entityNames[eid] || eid);
    });
    headerCols.push('Eliminations', 'Consolidated');

    const csvRows: string[] = [headerCols.map(c => `"${c}"`).join(',')];

    for (const row of data.rows) {
      const cols: string[] = [
        `"${row.groupAccountCode}"`,
        `"${row.groupAccountName}"`,
        `"${row.section}"`,
      ];
      entityIds.forEach(eid => {
        cols.push(String(row.entities[eid]?.amount ?? 0));
      });
      cols.push(String(row.elimination), String(row.consolidated));
      csvRows.push(cols.join(','));
    }

    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `consolidated-income-statement-${periodStart}-to-${periodEnd}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data, entityIds, periodStart, periodEnd]);

  /* ---------- Render helpers ---------- */
  const colCount = entityIds.length + 2; // entities + elimination + consolidated

  function renderSectionRows(rows: ConsolidatedISRow[]) {
    return rows.map(row => (
      <tr
        key={row.groupAccountCode || row.groupAccountName}
        className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50"
      >
        <td className="px-4 py-2.5 font-mono text-xs text-[var(--ff-text-tertiary)] sticky left-0 bg-[var(--ff-bg-secondary)] z-10">
          {row.groupAccountCode || '—'}
        </td>
        <td className="px-4 py-2.5 text-sm text-[var(--ff-text-primary)] sticky left-[80px] bg-[var(--ff-bg-secondary)] z-10">
          {row.groupAccountName}
        </td>
        {entityIds.map(eid => (
          <td key={eid} className="px-4 py-2.5 text-right text-sm text-[var(--ff-text-primary)] border-l border-[var(--ff-border-light)]">
            {(row.entities[eid]?.amount ?? 0) !== 0 ? fmt(row.entities[eid]?.amount ?? 0) : '—'}
          </td>
        ))}
        <td className="px-4 py-2.5 text-right text-sm border-l border-[var(--ff-border-light)] text-amber-400">
          {row.elimination !== 0 ? fmt(row.elimination) : '—'}
        </td>
        <td className="px-4 py-2.5 text-right text-sm font-semibold text-[var(--ff-text-primary)] border-l-2 border-[var(--ff-border-light)]">
          {fmt(row.consolidated)}
        </td>
      </tr>
    ));
  }

  function renderTotalsRow(label: string, totals: SectionTotals | undefined, bold: boolean, colorClass?: string) {
    if (!totals) return null;
    const textClass = colorClass || 'text-[var(--ff-text-primary)]';
    return (
      <tr className={`border-b-2 border-[var(--ff-border-light)] ${bold ? 'font-bold' : 'font-semibold'} bg-[var(--ff-bg-primary)]/30`}>
        <td className="px-4 py-3 sticky left-0 bg-[var(--ff-bg-secondary)] z-10" />
        <td className={`px-4 py-3 ${textClass} sticky left-[80px] bg-[var(--ff-bg-secondary)] z-10`}>
          {label}
        </td>
        {entityIds.map(eid => (
          <td key={eid} className={`px-4 py-3 text-right ${textClass} border-l border-[var(--ff-border-light)]`}>
            {fmt(totals.entities[eid] ?? 0)}
          </td>
        ))}
        <td className="px-4 py-3 text-right border-l border-[var(--ff-border-light)] text-amber-400">
          {fmt(totals.elimination)}
        </td>
        <td className={`px-4 py-3 text-right border-l-2 border-[var(--ff-border-light)] ${textClass}`}>
          {fmt(totals.consolidated)}
        </td>
      </tr>
    );
  }

  function renderSectionHeader(label: string, colorClass: string) {
    return (
      <tr className="bg-[var(--ff-bg-primary)]/50">
        <td className="px-4 py-2 sticky left-0 bg-[var(--ff-bg-secondary)] z-10" />
        <td colSpan={colCount + 1} className={`px-4 py-2 text-sm font-semibold ${colorClass}`}>
          {label}
        </td>
      </tr>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */
  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Building2 className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                  Consolidated Income Statement
                </h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Multi-entity profit &amp; loss with elimination entries
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <select
                value={selectedGroupId}
                onChange={e => setSelectedGroupId(e.target.value)}
                className={selectClass}
              >
                {groups.length === 0 && <option value="">No groups</option>}
                {groups.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
              <input
                type="date"
                value={periodStart}
                onChange={e => setPeriodStart(e.target.value)}
                className={inputClass}
              />
              <input
                type="date"
                value={periodEnd}
                onChange={e => setPeriodEnd(e.target.value)}
                className={inputClass}
              />
              <button
                onClick={handleExport}
                disabled={!data || data.rows.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50"
              >
                <Download className="h-4 w-4" /> Export CSV
              </button>
            </div>
          </div>
        </div>

        <div className="p-6">
          {/* Summary cards */}
          {!loading && data && data.netProfit && (
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Consolidated Revenue</p>
                <p className="text-xl font-bold text-teal-400">
                  {fmt(data.totalRevenue?.consolidated ?? 0)}
                </p>
              </div>
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Gross Profit</p>
                <p className={`text-xl font-bold ${(data.grossProfit?.consolidated ?? 0) >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                  {fmt(data.grossProfit?.consolidated ?? 0)}
                </p>
              </div>
              <div className={`rounded-lg border p-4 ${
                (data.netProfit.consolidated ?? 0) >= 0
                  ? 'bg-teal-500/5 border-teal-500/30'
                  : 'bg-red-500/5 border-red-500/30'
              }`}>
                <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Net Profit / (Loss)</p>
                <p className={`text-xl font-bold ${(data.netProfit.consolidated ?? 0) >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                  {fmt(data.netProfit.consolidated ?? 0)}
                </p>
              </div>
            </div>
          )}

          {/* States: loading / error / empty / table */}
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-8 justify-center">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : !data || data.rows.length === 0 ? (
            <div className="text-center py-12">
              <BarChart3 className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)]">
                No consolidated income statement data
              </p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">
                Select a group and date range with posted journal entries
              </p>
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                    <th className="px-4 py-3 sticky left-0 bg-[var(--ff-bg-secondary)] z-10">Code</th>
                    <th className="px-4 py-3 sticky left-[80px] bg-[var(--ff-bg-secondary)] z-10">Account Name</th>
                    {entityIds.map(eid => (
                      <th key={eid} className="px-4 py-3 text-right border-l border-[var(--ff-border-light)]">
                        {data.entityNames[eid]}
                      </th>
                    ))}
                    <th className="px-4 py-3 text-right border-l border-[var(--ff-border-light)] text-amber-400">
                      Eliminations
                    </th>
                    <th className="px-4 py-3 text-right border-l-2 border-[var(--ff-border-light)] font-bold">
                      Consolidated
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {/* Revenue */}
                  {renderSectionHeader('Revenue', 'text-teal-400')}
                  {renderSectionRows(revenueRows)}
                  {renderTotalsRow('Total Revenue', data.totalRevenue, false, 'text-teal-400')}

                  {/* Cost of Sales */}
                  {cosRows.length > 0 && (
                    <>
                      {renderSectionHeader('Cost of Sales', 'text-orange-400')}
                      {renderSectionRows(cosRows)}
                      {renderTotalsRow('Total Cost of Sales', data.totalCostOfSales, false, 'text-orange-400')}
                    </>
                  )}

                  {/* Gross Profit */}
                  {renderTotalsRow('Gross Profit', data.grossProfit, true,
                    (data.grossProfit?.consolidated ?? 0) >= 0 ? 'text-teal-400' : 'text-red-400')}

                  {/* Operating Expenses */}
                  {renderSectionHeader('Operating Expenses', 'text-red-400')}
                  {renderSectionRows(opexRows)}
                  {renderTotalsRow('Total Operating Expenses', data.totalOperatingExpenses, false, 'text-red-400')}

                  {/* Net Profit */}
                  {renderTotalsRow('Net Profit / (Loss)', data.netProfit, true,
                    (data.netProfit?.consolidated ?? 0) >= 0 ? 'text-teal-400' : 'text-red-400')}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
