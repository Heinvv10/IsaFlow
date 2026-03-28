/**
 * Consolidated Balance Sheet Page
 * Multi-entity balance sheet with elimination entries and consolidated totals.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { BarChart3, Loader2, AlertCircle, Download, Building2, CheckCircle2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface EntityAmount {
  balance: number;
}

interface ConsolidatedBSRow {
  groupAccountCode: string;
  groupAccountName: string;
  section: 'assets' | 'liabilities' | 'equity';
  entities: { [companyId: string]: EntityAmount };
  elimination: number;
  consolidated: number;
}

interface SectionTotals {
  entities: { [companyId: string]: number };
  elimination: number;
  consolidated: number;
}

interface ConsolidatedBSResponse {
  rows: ConsolidatedBSRow[];
  entityNames: { [companyId: string]: string };
  totalAssets: SectionTotals;
  totalLiabilities: SectionTotals;
  totalEquity: SectionTotals;
  totalLiabilitiesAndEquity: SectionTotals;
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

const defaultAsAtDate = new Date().toISOString().substring(0, 10);

const selectClass =
  'px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm';
const inputClass = selectClass;

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function ConsolidatedBalanceSheetPage() {
  const [groups, setGroups] = useState<EntityGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [asAtDate, setAsAtDate] = useState(defaultAsAtDate);

  const [data, setData] = useState<ConsolidatedBSResponse | null>(null);
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

  /* ---------- Load consolidated balance sheet ---------- */
  const loadData = useCallback(async () => {
    if (!selectedGroupId) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        group_id: selectedGroupId,
        action: 'balance-sheet',
        as_at_date: asAtDate,
      });
      const res = await apiFetch(`/api/accounting/consolidated-reports?${params}`);
      if (!res.ok) throw new Error('Failed to load consolidated balance sheet');
      const json = await res.json();
      const payload: ConsolidatedBSResponse = json.data || json;
      setData(payload);
    } catch {
      setError('Failed to load consolidated balance sheet');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [selectedGroupId, asAtDate]);

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

  const assetRows = useMemo(() => data?.rows.filter(r => r.section === 'assets') || [], [data]);
  const liabilityRows = useMemo(() => data?.rows.filter(r => r.section === 'liabilities') || [], [data]);
  const equityRows = useMemo(() => data?.rows.filter(r => r.section === 'equity') || [], [data]);

  const balanced = useMemo(() => {
    if (!data?.totalAssets || !data?.totalLiabilitiesAndEquity) return true;
    return Math.abs(data.totalAssets.consolidated - data.totalLiabilitiesAndEquity.consolidated) < 0.02;
  }, [data]);

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
        cols.push(String(row.entities[eid]?.balance ?? 0));
      });
      cols.push(String(row.elimination), String(row.consolidated));
      csvRows.push(cols.join(','));
    }

    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `consolidated-balance-sheet-${asAtDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data, entityIds, asAtDate]);

  /* ---------- Render helpers ---------- */
  const colCount = entityIds.length + 2;

  function renderSectionRows(rows: ConsolidatedBSRow[]) {
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
            {(row.entities[eid]?.balance ?? 0) !== 0 ? fmt(row.entities[eid]?.balance ?? 0) : '—'}
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
                  Consolidated Balance Sheet
                </h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Multi-entity balance sheet with elimination entries
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
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--ff-text-tertiary)]">As at</span>
                <input
                  type="date"
                  value={asAtDate}
                  onChange={e => setAsAtDate(e.target.value)}
                  className={inputClass}
                />
              </div>
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
          {!loading && data && data.totalAssets && (
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Total Assets</p>
                <p className="text-xl font-bold text-blue-400">
                  {fmt(data.totalAssets.consolidated)}
                </p>
              </div>
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Total L + E</p>
                <p className="text-xl font-bold text-blue-400">
                  {fmt(data.totalLiabilitiesAndEquity?.consolidated ?? 0)}
                </p>
              </div>
              <div className={`rounded-lg border p-4 ${
                balanced
                  ? 'bg-teal-500/5 border-teal-500/30'
                  : 'bg-red-500/5 border-red-500/30'
              }`}>
                <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Balance Check</p>
                <p className={`text-xl font-bold ${balanced ? 'text-teal-400' : 'text-red-400'}`}>
                  {balanced ? (
                    <span className="flex items-center gap-2">
                      <CheckCircle2 className="h-5 w-5" /> Balanced
                    </span>
                  ) : (
                    <span>
                      {fmt(Math.abs(data.totalAssets.consolidated - (data.totalLiabilitiesAndEquity?.consolidated ?? 0)))}
                      <span className="text-sm ml-2">Out of Balance</span>
                    </span>
                  )}
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
                No consolidated balance sheet data
              </p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">
                Select a group and date with posted journal entries
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
                  {/* Assets */}
                  {renderSectionHeader('Assets', 'text-blue-400')}
                  {renderSectionRows(assetRows)}
                  {renderTotalsRow('Total Assets', data.totalAssets, true, 'text-blue-400')}

                  {/* Liabilities */}
                  {renderSectionHeader('Liabilities', 'text-amber-400')}
                  {renderSectionRows(liabilityRows)}
                  {renderTotalsRow('Total Liabilities', data.totalLiabilities, false, 'text-amber-400')}

                  {/* Equity */}
                  {renderSectionHeader('Equity', 'text-purple-400')}
                  {renderSectionRows(equityRows)}
                  {renderTotalsRow('Total Equity', data.totalEquity, false, 'text-purple-400')}

                  {/* Total L + E */}
                  {renderTotalsRow('Total Liabilities + Equity', data.totalLiabilitiesAndEquity, true, 'text-blue-400')}
                </tbody>
              </table>
            </div>
          )}

          {/* Balance check footer */}
          {!loading && data && data.rows.length > 0 && (
            <div className="mt-4 flex items-center gap-4 text-sm">
              <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg ${
                balanced
                  ? 'bg-teal-500/10 text-teal-400'
                  : 'bg-red-500/10 text-red-400'
              }`}>
                {balanced ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <AlertCircle className="h-4 w-4" />
                )}
                {balanced
                  ? 'Consolidated balance sheet is balanced (A = L + E)'
                  : `Out of balance by ${fmt(Math.abs(data.totalAssets.consolidated - (data.totalLiabilitiesAndEquity?.consolidated ?? 0)))}`}
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
