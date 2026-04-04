/**
 * Consolidated Trial Balance Page — thin shell
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Scale, Loader2, AlertCircle, Download, Building2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { TBSummaryCards, TBBalanceFooter } from '@/components/accounting/group/TBSummaryCards';

interface EntityBalance { debit: number; credit: number }

interface ConsolidatedTBRow {
  groupAccountCode: string;
  groupAccountName: string;
  accountType: string;
  entities: { [companyId: string]: EntityBalance };
  eliminationDebit: number;
  eliminationCredit: number;
  consolidatedDebit: number;
  consolidatedCredit: number;
}

interface ConsolidatedTBResponse {
  rows: ConsolidatedTBRow[];
  entityNames: { [companyId: string]: string };
  totals: {
    entities: { [companyId: string]: EntityBalance };
    eliminationDebit: number;
    eliminationCredit: number;
    consolidatedDebit: number;
    consolidatedCredit: number;
  };
}

interface EntityGroup { id: string; name: string }

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const today = new Date();
const defaultPeriodStart = `${today.getFullYear()}-01-01`;
const defaultPeriodEnd = today.toISOString().substring(0, 10);
const cls = 'px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm';

export default function ConsolidatedTrialBalancePage() {
  const [groups, setGroups] = useState<EntityGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [periodStart, setPeriodStart] = useState(defaultPeriodStart);
  const [periodEnd, setPeriodEnd] = useState(defaultPeriodEnd);
  const [data, setData] = useState<ConsolidatedTBResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch('/api/accounting/company-groups').then(r => r.json()).then(json => {
      const items: EntityGroup[] = json.data?.items || json.data?.groups || json.data || [];
      setGroups(items);
      if (items.length > 0 && !selectedGroupId && items[0]) setSelectedGroupId(items[0].id);
    }).catch(() => { /* non-critical */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadData = useCallback(async () => {
    if (!selectedGroupId) return;
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ group_id: selectedGroupId, action: 'trial-balance', period_start: periodStart, period_end: periodEnd });
      const res = await apiFetch(`/api/accounting/consolidated-reports?${params}`);
      if (!res.ok) throw new Error('Failed to load consolidated trial balance');
      const json = await res.json();
      setData(json.data || json);
    } catch { setError('Failed to load consolidated trial balance'); setData(null); }
    finally { setLoading(false); }
  }, [selectedGroupId, periodStart, periodEnd]);

  useEffect(() => { loadData(); }, [loadData]);

  const entityIds = useMemo(() => {
    if (!data) return [];
    return Object.keys(data.entityNames).sort((a, b) => (data.entityNames[a] || '').localeCompare(data.entityNames[b] || ''));
  }, [data]);

  const totals = data?.totals;

  const consolidatedBalanced = useMemo(() => {
    if (!totals) return true;
    return Math.abs(totals.consolidatedDebit - totals.consolidatedCredit) < 0.02;
  }, [totals]);

  const handleExport = useCallback(() => {
    if (!data || data.rows.length === 0) return;
    const headerCols = ['Group Account Code', 'Account Name', 'Account Type'];
    entityIds.forEach(eid => { const name = data.entityNames[eid] || eid; headerCols.push(`${name} Debit`, `${name} Credit`); });
    headerCols.push('Eliminations Debit', 'Eliminations Credit', 'Consolidated Debit', 'Consolidated Credit');
    const csvRows: string[] = [headerCols.map(c => `"${c}"`).join(',')];
    for (const row of data.rows) {
      const cols: string[] = [`"${row.groupAccountCode}"`, `"${row.groupAccountName}"`, `"${row.accountType}"`];
      entityIds.forEach(eid => { const eb = row.entities[eid]; cols.push(String(eb?.debit ?? 0), String(eb?.credit ?? 0)); });
      cols.push(String(row.eliminationDebit), String(row.eliminationCredit), String(row.consolidatedDebit), String(row.consolidatedCredit));
      csvRows.push(cols.join(','));
    }
    if (totals) {
      const tCols: string[] = ['""', '"TOTALS"', '""'];
      entityIds.forEach(eid => { const eb = totals.entities[eid]; tCols.push(String(eb?.debit ?? 0), String(eb?.credit ?? 0)); });
      tCols.push(String(totals.eliminationDebit), String(totals.eliminationCredit), String(totals.consolidatedDebit), String(totals.consolidatedCredit));
      csvRows.push(tCols.join(','));
    }
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `consolidated-trial-balance-${periodStart}-to-${periodEnd}.csv`; a.click();
    URL.revokeObjectURL(url);
  }, [data, entityIds, totals, periodStart, periodEnd]);

  const hasElimination = (row: ConsolidatedTBRow) => row.eliminationDebit > 0 || row.eliminationCredit > 0;
  const isUnmapped = (row: ConsolidatedTBRow) => !row.groupAccountCode || row.groupAccountCode === '';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-indigo-500/10"><Building2 className="h-6 w-6 text-indigo-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Consolidated Trial Balance</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Multi-entity trial balance with elimination entries</p>
              </div>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <select value={selectedGroupId} onChange={e => setSelectedGroupId(e.target.value)} className={cls}>
                {groups.length === 0 && <option value="">No groups</option>}
                {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} className={cls} />
              <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} className={cls} />
              <button onClick={handleExport} disabled={!data || data.rows.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium disabled:opacity-50">
                <Download className="h-4 w-4" /> Export CSV
              </button>
            </div>
          </div>
        </div>

        <div className="p-6">
          {!loading && data && data.rows.length > 0 && totals && (
            <TBSummaryCards totals={totals} consolidatedBalanced={consolidatedBalanced} />
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-indigo-500" /></div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-8 justify-center"><AlertCircle className="h-5 w-5" /><span>{error}</span></div>
          ) : !data || data.rows.length === 0 ? (
            <div className="text-center py-12">
              <Scale className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)]">No consolidated trial balance data</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">Select a group and date range with posted journal entries</p>
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                    <th className="px-4 py-3 sticky left-0 bg-[var(--ff-bg-secondary)] z-10">Code</th>
                    <th className="px-4 py-3 sticky left-[80px] bg-[var(--ff-bg-secondary)] z-10">Account Name</th>
                    {entityIds.map(eid => (
                      <th key={eid} colSpan={2} className="px-4 py-3 text-center border-l border-[var(--ff-border-light)]">{data.entityNames[eid]}</th>
                    ))}
                    <th colSpan={2} className="px-4 py-3 text-center border-l border-[var(--ff-border-light)] text-amber-400">Eliminations</th>
                    <th colSpan={2} className="px-4 py-3 text-center border-l-2 border-[var(--ff-border-light)] font-bold">Consolidated</th>
                  </tr>
                  <tr className="border-b border-[var(--ff-border-light)] text-xs text-[var(--ff-text-tertiary)]">
                    <th className="px-4 py-2 sticky left-0 bg-[var(--ff-bg-secondary)] z-10" />
                    <th className="px-4 py-2 sticky left-[80px] bg-[var(--ff-bg-secondary)] z-10" />
                    {entityIds.map(eid => (
                      <React.Fragment key={`sub-${eid}`}>
                        <th className="px-4 py-2 text-right border-l border-[var(--ff-border-light)]">Debit</th>
                        <th className="px-4 py-2 text-right">Credit</th>
                      </React.Fragment>
                    ))}
                    <th className="px-4 py-2 text-right border-l border-[var(--ff-border-light)]">Debit</th>
                    <th className="px-4 py-2 text-right">Credit</th>
                    <th className="px-4 py-2 text-right border-l-2 border-[var(--ff-border-light)]">Debit</th>
                    <th className="px-4 py-2 text-right">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(row => {
                    const elimRow = hasElimination(row);
                    const unmapped = isUnmapped(row);
                    const rowBg = unmapped ? 'bg-red-500/10' : elimRow ? 'bg-amber-500/5' : '';
                    return (
                      <tr key={row.groupAccountCode || row.groupAccountName} className={`border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50 ${rowBg}`}>
                        <td className="px-4 py-3 font-mono text-[var(--ff-text-tertiary)] sticky left-0 bg-[var(--ff-bg-secondary)] z-10">
                          <span className="flex items-center gap-1">
                            {unmapped && <AlertCircle className="h-3.5 w-3.5 text-red-400 shrink-0" />}
                            {row.groupAccountCode || '—'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-[var(--ff-text-primary)] sticky left-[80px] bg-[var(--ff-bg-secondary)] z-10">{row.groupAccountName}</td>
                        {entityIds.map(eid => {
                          const eb = row.entities[eid];
                          return (
                            <React.Fragment key={eid}>
                              <td className="px-4 py-3 text-right text-[var(--ff-text-primary)] border-l border-[var(--ff-border-light)]">{(eb?.debit ?? 0) > 0 ? fmt(eb?.debit ?? 0) : '—'}</td>
                              <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{(eb?.credit ?? 0) > 0 ? fmt(eb?.credit ?? 0) : '—'}</td>
                            </React.Fragment>
                          );
                        })}
                        <td className="px-4 py-3 text-right border-l border-[var(--ff-border-light)] text-amber-400">{row.eliminationDebit > 0 ? fmt(row.eliminationDebit) : '—'}</td>
                        <td className="px-4 py-3 text-right text-amber-400">{row.eliminationCredit > 0 ? fmt(row.eliminationCredit) : '—'}</td>
                        <td className="px-4 py-3 text-right font-semibold text-[var(--ff-text-primary)] border-l-2 border-[var(--ff-border-light)]">{row.consolidatedDebit > 0 ? fmt(row.consolidatedDebit) : '—'}</td>
                        <td className="px-4 py-3 text-right font-semibold text-[var(--ff-text-primary)]">{row.consolidatedCredit > 0 ? fmt(row.consolidatedCredit) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-[var(--ff-border-light)] font-bold">
                    <td className="px-4 py-3 text-[var(--ff-text-primary)] sticky left-0 bg-[var(--ff-bg-secondary)] z-10">TOTALS</td>
                    <td className="px-4 py-3 sticky left-[80px] bg-[var(--ff-bg-secondary)] z-10" />
                    {entityIds.map(eid => {
                      const eb = totals?.entities[eid];
                      return (
                        <React.Fragment key={`tot-${eid}`}>
                          <td className="px-4 py-3 text-right text-[var(--ff-text-primary)] border-l border-[var(--ff-border-light)]">{fmt(eb?.debit ?? 0)}</td>
                          <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(eb?.credit ?? 0)}</td>
                        </React.Fragment>
                      );
                    })}
                    <td className="px-4 py-3 text-right border-l border-[var(--ff-border-light)] text-amber-400">{fmt(totals?.eliminationDebit ?? 0)}</td>
                    <td className="px-4 py-3 text-right text-amber-400">{fmt(totals?.eliminationCredit ?? 0)}</td>
                    <td className="px-4 py-3 text-right border-l-2 border-[var(--ff-border-light)] text-[var(--ff-text-primary)]">{fmt(totals?.consolidatedDebit ?? 0)}</td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(totals?.consolidatedCredit ?? 0)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {!loading && data && data.rows.length > 0 && totals && (
            <TBBalanceFooter
              totals={totals}
              consolidatedBalanced={consolidatedBalanced}
              hasUnmapped={data.rows.some(isUnmapped)}
              hasEliminations={data.rows.some(hasElimination)}
            />
          )}
        </div>
      </div>
    </AppLayout>
  );
}
