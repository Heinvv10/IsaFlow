/**
 * Group Dashboard — thin shell
 * Consolidated view across multiple entities in a company group.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import {
  Building2, ChevronDown, Plus, Loader2, AlertCircle,
  TrendingUp, DollarSign, Landmark, CreditCard, ArrowRight,
  Settings, Scale, FileSpreadsheet, BarChart3, Layers, FileText, RefreshCw,
} from 'lucide-react';
import { GroupEntityTable } from '@/components/accounting/group/GroupEntityTable';

interface CompanyGroup { id: string; name: string; holdingCompanyName: string; memberCount: number }
interface EntitySummary { companyId: string; companyName: string; revenue: number; expenses: number; netProfit: number; cashPosition: number }
interface GroupDashboardData { combinedCash: number; combinedRevenue: number; combinedAR: number; combinedAP: number; entities: EntitySummary[] }

const fmtCurrency = (n: number) => 'R ' + new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const fmtCompact = (n: number) => {
  if (Math.abs(n) >= 1_000_000) return 'R ' + (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return 'R ' + (n / 1_000).toFixed(1) + 'K';
  return fmtCurrency(n);
};

const QUICK_LINKS = [
  { label: 'Consolidated Trial Balance', href: '/accounting/group/trial-balance', icon: Scale, description: 'Combined trial balance across all entities' },
  { label: 'Consolidated Income Statement', href: '/accounting/group/income-statement', icon: TrendingUp, description: 'Revenue and expenses for the group' },
  { label: 'Consolidated Balance Sheet', href: '/accounting/group/balance-sheet', icon: FileSpreadsheet, description: 'Assets, liabilities, and equity' },
  { label: 'Intercompany Reconciliation', href: '/accounting/group/intercompany', icon: Layers, description: 'Reconcile balances between entities' },
  { label: 'Elimination Adjustments', href: '/accounting/group/eliminations', icon: FileText, description: 'Manage consolidation eliminations' },
];

const STAT_CARDS = [
  { key: 'combinedCash', label: 'Combined Cash', sub: 'Across all entities', Icon: Landmark },
  { key: 'combinedRevenue', label: 'Combined Revenue', sub: 'Current period', Icon: TrendingUp },
  { key: 'combinedAR', label: 'Outstanding AR', sub: 'Accounts receivable', Icon: DollarSign },
  { key: 'combinedAP', label: 'Outstanding AP', sub: 'Accounts payable', Icon: CreditCard },
] as const;

export default function GroupDashboardPage() {
  const [groups, setGroups] = useState<CompanyGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [dashData, setDashData] = useState<GroupDashboardData | null>(null);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loadingDash, setLoadingDash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const loadGroups = useCallback(async () => {
    setLoadingGroups(true); setError(null);
    try {
      const res = await apiFetch('/api/accounting/company-groups');
      if (!res.ok) throw new Error('Failed to load company groups');
      const json = await res.json();
      const list: CompanyGroup[] = json.data?.items ?? json.data ?? [];
      setGroups(list);
      if (list.length > 0 && !selectedGroupId && list[0]) setSelectedGroupId(list[0].id);
    } catch (err) {
      log.error('Failed to load company groups', { error: err }, 'group-dashboard');
      setError('Could not load company groups.');
    } finally { setLoadingGroups(false); }
  }, [selectedGroupId]);

  useEffect(() => { void loadGroups(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const loadDashboard = useCallback(async (groupId: string) => {
    setLoadingDash(true); setError(null);
    try {
      const res = await apiFetch(`/api/accounting/consolidated-reports?group_id=${encodeURIComponent(groupId)}&action=dashboard`);
      if (!res.ok) throw new Error('Failed to load dashboard data');
      const json = await res.json();
      setDashData(json.data ?? json);
    } catch (err) {
      log.error('Failed to load group dashboard', { error: err }, 'group-dashboard');
      setError('Could not load consolidated dashboard.');
    } finally { setLoadingDash(false); }
  }, []);

  useEffect(() => { if (selectedGroupId) void loadDashboard(selectedGroupId); }, [selectedGroupId, loadDashboard]);

  const selectedGroup = groups.find(g => g.id === selectedGroupId) ?? null;

  const totals = (dashData?.entities ?? []).reduce(
    (acc, e) => ({ revenue: acc.revenue + e.revenue, expenses: acc.expenses + e.expenses, netProfit: acc.netProfit + e.netProfit, cashPosition: acc.cashPosition + e.cashPosition }),
    { revenue: 0, expenses: 0, netProfit: 0, cashPosition: 0 },
  );

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-teal-500/10"><Building2 className="h-6 w-6 text-teal-500" /></div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Group Companies</h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">Consolidated view across entities</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {loadingGroups ? (
                  <Loader2 className="h-5 w-5 animate-spin text-teal-500" />
                ) : groups.length === 0 ? (
                  <Link href="/accounting/group/setup" className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium">
                    <Plus className="h-4 w-4" /> Create Group
                  </Link>
                ) : (
                  <div className="relative">
                    <button onClick={() => setDropdownOpen(o => !o)}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] text-[var(--ff-text-primary)] text-sm font-medium hover:border-teal-500/50 transition-colors">
                      <Building2 className="h-4 w-4 text-teal-500" />
                      {selectedGroup?.name ?? 'Select Group'}
                      <ChevronDown className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                    </button>
                    {dropdownOpen && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setDropdownOpen(false)} />
                        <div className="absolute right-0 mt-1 z-20 w-64 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] shadow-lg py-1">
                          {groups.map(g => (
                            <button key={g.id} onClick={() => { setSelectedGroupId(g.id); setDropdownOpen(false); }}
                              className={`w-full text-left px-4 py-2 text-sm transition-colors ${g.id === selectedGroupId ? 'bg-teal-500/10 text-teal-500' : 'text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-secondary)]'}`}>
                              <span className="font-medium">{g.name}</span>
                              <span className="block text-xs text-[var(--ff-text-tertiary)]">{g.memberCount} {g.memberCount === 1 ? 'entity' : 'entities'}</span>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {error && (
            <div className="flex items-center gap-3 p-4 rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-400 text-sm">
              <AlertCircle className="h-5 w-5 flex-shrink-0" />
              <span>{error}</span>
              <button onClick={() => selectedGroupId ? void loadDashboard(selectedGroupId) : void loadGroups()}
                className="ml-auto inline-flex items-center gap-1 text-xs font-medium hover:text-rose-300 transition-colors">
                <RefreshCw className="h-3.5 w-3.5" /> Retry
              </button>
            </div>
          )}

          {!loadingGroups && groups.length === 0 && !error && (
            <div className="text-center py-20">
              <Building2 className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-4" />
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-2">No Company Groups</h2>
              <p className="text-sm text-[var(--ff-text-secondary)] mb-6 max-w-md mx-auto">Create a group to consolidate financial data across multiple entities.</p>
              <Link href="/accounting/group/setup" className="inline-flex items-center gap-2 px-5 py-2.5 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium">
                <Plus className="h-4 w-4" /> Create Your First Group
              </Link>
            </div>
          )}

          {loadingDash && selectedGroupId && (
            <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-teal-500" /></div>
          )}

          {selectedGroup && dashData && !loadingDash && (
            <>
              <div className="flex items-center justify-between flex-wrap gap-3 p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                <div>
                  <p className="text-sm font-medium text-[var(--ff-text-primary)]">{selectedGroup.name}</p>
                  <p className="text-xs text-[var(--ff-text-tertiary)]">Holding: {selectedGroup.holdingCompanyName} &middot; {selectedGroup.memberCount} {selectedGroup.memberCount === 1 ? 'entity' : 'entities'}</p>
                </div>
                <Link href="/accounting/group/setup" className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--ff-border-primary)] text-sm text-[var(--ff-text-secondary)] hover:text-teal-500 hover:border-teal-500/50 transition-colors">
                  <Settings className="h-3.5 w-3.5" /> Manage Group
                </Link>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {STAT_CARDS.map(({ key, label, sub, Icon }) => (
                  <div key={key} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]">{label}</span>
                      <Icon className="h-4 w-4 text-teal-500" />
                    </div>
                    <p className="text-2xl font-bold text-[var(--ff-text-primary)]">{fmtCompact(dashData[key])}</p>
                    <p className="text-xs mt-1 text-[var(--ff-text-tertiary)]">{sub}</p>
                  </div>
                ))}
              </div>

              <GroupEntityTable entities={dashData.entities} totals={totals} />

              <div>
                <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-3">Consolidated Reports</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {QUICK_LINKS.map(link => {
                    const Icon = link.icon;
                    return (
                      <Link key={link.href} href={link.href}
                        className="flex items-center gap-3 p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] hover:border-teal-500/50 hover:bg-teal-500/5 transition-colors group">
                        <div className="p-2 rounded-lg bg-teal-500/10 group-hover:bg-teal-500/20 transition-colors">
                          <Icon className="h-4 w-4 text-teal-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-[var(--ff-text-primary)] group-hover:text-teal-500 transition-colors">{link.label}</p>
                          <p className="text-xs text-[var(--ff-text-tertiary)] truncate">{link.description}</p>
                        </div>
                        <ArrowRight className="h-4 w-4 text-[var(--ff-text-tertiary)] group-hover:text-teal-500 transition-colors flex-shrink-0" />
                      </Link>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
