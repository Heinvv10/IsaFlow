/**
 * Accounting Module - Main Page
 * Tabbed interface: Overview, Chart of Accounts, Journal Entries, Fiscal Periods, Reports
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCompany } from '@/contexts/CompanyContext';
import { log } from '@/lib/logger';
import Link from 'next/link';
import {
  Calculator,
  BookOpen,
  FileSpreadsheet,
  Calendar,
  BarChart3,
  Plus,
  ChevronRight,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Clock,
  Lock,
  ArrowRight,
  TrendingUp,
  DollarSign,
  FileText,
  CreditCard,
  Landmark,
  Pencil,
  Trash2,
  Save,
  X,
} from 'lucide-react';
import dynamic from 'next/dynamic';

const LineChart = dynamic(() => import('recharts').then(m => m.LineChart), { ssr: false });
const Line = dynamic(() => import('recharts').then(m => m.Line), { ssr: false });
const BarChart = dynamic(() => import('recharts').then(m => m.BarChart), { ssr: false });
const Bar = dynamic(() => import('recharts').then(m => m.Bar), { ssr: false });
const PieChart = dynamic(() => import('recharts').then(m => m.PieChart), { ssr: false });
const Pie = dynamic(() => import('recharts').then(m => m.Pie), { ssr: false });
const Cell = dynamic(() => import('recharts').then(m => m.Cell), { ssr: false });
const XAxis = dynamic(() => import('recharts').then(m => m.XAxis), { ssr: false });
const YAxis = dynamic(() => import('recharts').then(m => m.YAxis), { ssr: false });
const CartesianGrid = dynamic(() => import('recharts').then(m => m.CartesianGrid), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then(m => m.Tooltip), { ssr: false });
const Legend = dynamic(() => import('recharts').then(m => m.Legend), { ssr: false });
const ResponsiveContainer = dynamic(() => import('recharts').then(m => m.ResponsiveContainer), { ssr: false });
import { DisplayModeToggle } from '@/components/accounting/DisplayModeToggle';
import { useDisplayMode } from '@/hooks/useDisplayMode';
import {
  AccountCategorySidebar,
  filterAccounts,
  type AccountCategoryType,
} from '@/components/accounting/AccountCategorySidebar';
import type { GLAccount, GLAccountType, FiscalPeriod, JournalEntry, TrialBalanceRow } from '@/modules/accounting/types/gl.types';
import { apiFetch } from '@/lib/apiFetch';
import { WidgetGrid } from '@/components/dashboard/WidgetGrid';
import type { WidgetConfig } from '@/components/dashboard/widgetTypes';
import { DEFAULT_WIDGET_LAYOUT } from '@/components/dashboard/widgetTypes';

type AccountingTab = 'overview' | 'chart-of-accounts' | 'journal-entries' | 'fiscal-periods' | 'reports';

const TABS: { id: AccountingTab; label: string; icon: React.ElementType }[] = [
  { id: 'overview', label: 'Overview', icon: Calculator },
  { id: 'chart-of-accounts', label: 'Chart of Accounts', icon: BookOpen },
  { id: 'journal-entries', label: 'Journal Entries', icon: FileSpreadsheet },
  { id: 'fiscal-periods', label: 'Fiscal Periods', icon: Calendar },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
];

export default function AccountingPage() {
  const router = useRouter();
  const { activeCompany } = useCompany();
  const [activeTab, setActiveTab] = useState<AccountingTab>('overview');
  const [isMounted, setIsMounted] = useState(false);
  const [widgetLayout, setWidgetLayout] = useState<WidgetConfig[]>(DEFAULT_WIDGET_LAYOUT);
  const [editMode, setEditMode] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Sync tab from URL
  useEffect(() => {
    if (!isMounted) return;
    const tab = router.query.tab as AccountingTab;
    if (tab && TABS.some(t => t.id === tab)) {
      setActiveTab(tab);
    }
  }, [router.query.tab, isMounted]);

  const handleTabChange = useCallback((tab: AccountingTab) => {
    setActiveTab(tab);
    router.push({ pathname: '/accounting', query: { tab } }, undefined, { shallow: true });
  }, [router]);

  // Load saved widget layout
  useEffect(() => {
    if (!isMounted) return;
    apiFetch('/api/accounting/widget-layout')
      .then(res => res.json())
      .then((json: { data?: { layout?: WidgetConfig[] } }) => {
        const layout = json.data?.layout;
        if (Array.isArray(layout) && layout.length > 0) {
          setWidgetLayout(layout);
        }
      })
      .catch(err => log.error('Failed to load widget layout', { error: err }, 'accounting-page'));
  }, [isMounted]);

  const handleLayoutChange = useCallback((layout: WidgetConfig[]) => {
    setWidgetLayout(layout);
    apiFetch('/api/accounting/widget-layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout }),
    }).catch(err => log.error('Failed to save widget layout', { error: err }, 'accounting-page'));
  }, []);

  if (!isMounted) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
          <div className="text-center">
            <Loader2 className="h-8 w-8 animate-spin text-teal-500 mx-auto mb-2" />
            <p className="text-[var(--ff-text-secondary)]">Loading accounting module...</p>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]" data-tour="dashboard">
        {/* Page Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-teal-500/10">
                  <Calculator className="h-6 w-6 text-teal-500" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{activeCompany?.tradingName || activeCompany?.name || 'ISAFlow'}</h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">
                    General Ledger, Journal Entries & Financial Reports
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {activeTab === 'journal-entries' && (
                  <Link
                    href="/accounting/journal-entries/new"
                    className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium"
                  >
                    <Plus className="h-4 w-4" />
                    New Journal Entry
                  </Link>
                )}
                </div>
            </div>
          </div>

          {/* Tab Navigation */}
          <div className="px-6 border-t border-[var(--ff-border-light)]">
            <nav className="flex gap-0 -mb-px overflow-x-auto" aria-label="Accounting tabs">
              {TABS.map(tab => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => handleTabChange(tab.id)}
                    className={`
                      flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap
                      ${isActive
                        ? 'border-teal-500 text-teal-600'
                        : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:border-[var(--ff-border-medium)]'
                      }
                    `}
                  >
                    <Icon className="h-4 w-4" />
                    {tab.label}
                  </button>
                );
              })}
            </nav>
          </div>
        </div>

        {/* Tab Content */}
        <div className="p-6">
          {activeTab === 'overview' && <OverviewTab />}
          {activeTab === 'chart-of-accounts' && <ChartOfAccountsTab />}
          {activeTab === 'journal-entries' && <JournalEntriesTab />}
          {activeTab === 'fiscal-periods' && <FiscalPeriodsTab />}
          {activeTab === 'reports' && <ReportsTab />}
        </div>

      </div>
    </AppLayout>
  );
}

// =====================================================
// Overview Tab — KPI Dashboard
// =====================================================

function fmtCurrency(n: number): string {
  return 'R ' + new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function fmtCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return 'R ' + (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return 'R ' + (n / 1_000).toFixed(1) + 'K';
  return fmtCurrency(n);
}

interface KPIData {
  kpis: {
    revenue: { total: number; priorTotal: number; changePercent: number };
    expenses: { total: number; priorTotal: number };
    grossProfit: { amount: number; margin: number };
    netProfit: { amount: number; margin: number };
    cash: { total: number; priorTotal: number; change: number };
    receivables: { total: number; overdue: number; avgDebtorDays: number };
    payables: { total: number; overdue: number; avgCreditorDays: number };
    activity: { invoicesIssued: number; paymentsReceived: number; journalsPosted: number };
  };
  revenueChart: { month: string; revenue: number; expenses: number }[];
  cashFlowChart: { month: string; inflows: number; outflows: number }[];
  arAging: { name: string; value: number }[];
  apAging: { name: string; value: number }[];
  topCustomers: { name: string; revenue: number; invoiceCount: number }[];
  topExpenses: { accountName: string; total: number; percentOfExpenses: number }[];
}

function OverviewTab() {
  const [data, setData] = useState<KPIData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadKPIData();
  }, []);

  const loadKPIData = async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/accounting/kpi-dashboard', { credentials: 'include' });
      const json = await res.json();
      const payload = json.data || json;
      setData(payload);
    } catch (err) {
      log.error('Failed to load KPI data', { error: err }, 'accounting-ui');
    } finally {
      setIsLoading(false);
    }
  };

  const kpis = data?.kpis;
  const AGING_COLORS = ['#14b8a6', '#fbbf24', '#f97316', '#f43f5e'];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link
          href="/accounting/journal-entries/new"
          className="flex items-center gap-3 p-4 bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] hover:border-teal-500/50 hover:shadow-md transition-all group no-underline"
        >
          <div className="p-2 rounded-lg bg-teal-500/10">
            <Plus className="h-5 w-5 text-teal-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-[var(--ff-text-primary)]">New Journal Entry</p>
            <p className="text-sm text-[var(--ff-text-secondary)]">Create a manual journal entry</p>
          </div>
          <ArrowRight className="h-4 w-4 text-[var(--ff-text-tertiary)] group-hover:text-teal-500 transition-colors" />
        </Link>

        <Link
          href="/accounting/trial-balance"
          className="flex items-center gap-3 p-4 bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] hover:border-blue-500/50 hover:shadow-md transition-all group no-underline"
        >
          <div className="p-2 rounded-lg bg-blue-500/10">
            <BarChart3 className="h-5 w-5 text-blue-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-[var(--ff-text-primary)]">Trial Balance</p>
            <p className="text-sm text-[var(--ff-text-secondary)]">View trial balance report</p>
          </div>
          <ArrowRight className="h-4 w-4 text-[var(--ff-text-tertiary)] group-hover:text-blue-500 transition-colors" />
        </Link>

        <Link
          href="/accounting/bank-reconciliation"
          className="flex items-center gap-3 p-4 bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] hover:border-indigo-500/50 hover:shadow-md transition-all group no-underline"
        >
          <div className="p-2 rounded-lg bg-indigo-500/10">
            <Landmark className="h-5 w-5 text-indigo-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-[var(--ff-text-primary)]">Bank Reconciliation</p>
            <p className="text-sm text-[var(--ff-text-secondary)]">Match statements to GL entries</p>
          </div>
          <ArrowRight className="h-4 w-4 text-[var(--ff-text-tertiary)] group-hover:text-indigo-500 transition-colors" />
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link
          href="/accounting/supplier-invoices"
          className="flex items-center gap-3 p-4 bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] hover:border-orange-500/50 hover:shadow-md transition-all group no-underline"
        >
          <div className="p-2 rounded-lg bg-orange-500/10">
            <FileText className="h-5 w-5 text-orange-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-[var(--ff-text-primary)]">Supplier Invoices</p>
            <p className="text-sm text-[var(--ff-text-secondary)]">AP invoices, matching & approvals</p>
          </div>
          <ArrowRight className="h-4 w-4 text-[var(--ff-text-tertiary)] group-hover:text-orange-500 transition-colors" />
        </Link>

        <Link
          href="/accounting/customer-payments"
          className="flex items-center gap-3 p-4 bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] hover:border-teal-500/50 hover:shadow-md transition-all group no-underline"
        >
          <div className="p-2 rounded-lg bg-teal-500/10">
            <CreditCard className="h-5 w-5 text-teal-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-[var(--ff-text-primary)]">Customer Payments</p>
            <p className="text-sm text-[var(--ff-text-secondary)]">Record & allocate payments</p>
          </div>
          <ArrowRight className="h-4 w-4 text-[var(--ff-text-tertiary)] group-hover:text-teal-500 transition-colors" />
        </Link>

        <Link
          href="/accounting/ar-aging"
          className="flex items-center gap-3 p-4 bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] hover:border-teal-500/50 hover:shadow-md transition-all group no-underline"
        >
          <div className="p-2 rounded-lg bg-teal-500/10">
            <TrendingUp className="h-5 w-5 text-teal-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-[var(--ff-text-primary)]">AR Aging Report</p>
            <p className="text-sm text-[var(--ff-text-secondary)]">Outstanding receivables by age</p>
          </div>
          <ArrowRight className="h-4 w-4 text-[var(--ff-text-tertiary)] group-hover:text-teal-500 transition-colors" />
        </Link>
      </div>

      {/* Row 1 — Key Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Revenue */}
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]">Revenue</span>
            <TrendingUp className="h-4 w-4 text-teal-500" />
          </div>
          <p className="text-2xl font-bold text-[var(--ff-text-primary)]">{fmtCompact(kpis?.revenue.total ?? 0)}</p>
          <p className={`text-xs mt-1 ${(kpis?.revenue.changePercent ?? 0) >= 0 ? 'text-teal-500' : 'text-rose-500'}`}>
            {(kpis?.revenue.changePercent ?? 0) >= 0 ? '+' : ''}{(kpis?.revenue.changePercent ?? 0).toFixed(1)}% vs prior period
          </p>
        </div>

        {/* Gross Profit */}
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]">Gross Profit</span>
            <DollarSign className="h-4 w-4 text-teal-500" />
          </div>
          <p className="text-2xl font-bold text-[var(--ff-text-primary)]">{fmtCompact(kpis?.grossProfit.amount ?? 0)}</p>
          <p className="text-xs mt-1 text-[var(--ff-text-tertiary)]">
            Margin: {(kpis?.grossProfit.margin ?? 0).toFixed(1)}%
          </p>
        </div>

        {/* Cash Position */}
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]">Cash Position</span>
            <Landmark className="h-4 w-4 text-teal-500" />
          </div>
          <p className="text-2xl font-bold text-[var(--ff-text-primary)]">{fmtCompact(kpis?.cash.total ?? 0)}</p>
          <p className={`text-xs mt-1 ${(kpis?.cash.change ?? 0) >= 0 ? 'text-teal-500' : 'text-rose-500'}`}>
            {(kpis?.cash.change ?? 0) >= 0 ? '+' : ''}{fmtCompact(kpis?.cash.change ?? 0)} change
          </p>
        </div>

        {/* Outstanding AR */}
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]">Outstanding AR</span>
            <CreditCard className="h-4 w-4 text-teal-500" />
          </div>
          <p className="text-2xl font-bold text-[var(--ff-text-primary)]">{fmtCompact(kpis?.receivables.total ?? 0)}</p>
          {(kpis?.receivables.overdue ?? 0) > 0 ? (
            <p className="text-xs mt-1 text-rose-500">
              {fmtCompact(kpis?.receivables.overdue ?? 0)} overdue
            </p>
          ) : (
            <p className="text-xs mt-1 text-teal-500">No overdue</p>
          )}
        </div>
      </div>

      {/* Row 2 — Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Revenue vs Expenses Line Chart */}
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
          <h3 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">Revenue vs Expenses</h3>
          {(data?.revenueChart?.length ?? 0) > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={data?.revenueChart ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--ff-border-light)" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--ff-text-secondary)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--ff-text-secondary)' }} tickFormatter={(v) => fmtCompact(Number(v))} />
                <Tooltip
                  contentStyle={{ backgroundColor: 'var(--ff-bg-secondary)', border: '1px solid var(--ff-border-light)', borderRadius: '8px', color: 'var(--ff-text-primary)' }}
                  formatter={(value) => [fmtCurrency(Number(value)), '']}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="revenue" name="Revenue" stroke="#14b8a6" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="expenses" name="Expenses" stroke="#f43f5e" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[260px] text-[var(--ff-text-tertiary)] text-sm">No data available</div>
          )}
        </div>

        {/* Cash Flow Bar Chart */}
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
          <h3 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">Cash Flow</h3>
          {(data?.cashFlowChart?.length ?? 0) > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data?.cashFlowChart ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--ff-border-light)" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--ff-text-secondary)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--ff-text-secondary)' }} tickFormatter={(v) => fmtCompact(Number(v))} />
                <Tooltip
                  contentStyle={{ backgroundColor: 'var(--ff-bg-secondary)', border: '1px solid var(--ff-border-light)', borderRadius: '8px', color: 'var(--ff-text-primary)' }}
                  formatter={(value) => [fmtCurrency(Number(value)), '']}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="inflows" name="Inflows" fill="#2dd4bf" radius={[4, 4, 0, 0]} />
                <Bar dataKey="outflows" name="Outflows" fill="#fb923c" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[260px] text-[var(--ff-text-tertiary)] text-sm">No data available</div>
          )}
        </div>
      </div>

      {/* Row 3 — Tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Top 5 Customers */}
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
          <div className="px-5 py-3 border-b border-[var(--ff-border-light)]">
            <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Top 5 Customers by Revenue</h3>
          </div>
          {(data?.topCustomers?.length ?? 0) > 0 ? (
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)]">
                  <th className="px-5 py-2 text-left text-xs font-medium uppercase text-[var(--ff-text-secondary)]">Customer</th>
                  <th className="px-5 py-2 text-right text-xs font-medium uppercase text-[var(--ff-text-secondary)]">Revenue</th>
                  <th className="px-5 py-2 text-right text-xs font-medium uppercase text-[var(--ff-text-secondary)]">Invoices</th>
                </tr>
              </thead>
              <tbody>
                {(data?.topCustomers ?? []).map((c, i) => (
                  <tr key={i} className="border-b border-[var(--ff-border-light)]/50 last:border-0">
                    <td className="px-5 py-2.5 text-sm text-[var(--ff-text-primary)] truncate max-w-[200px]">{c.name}</td>
                    <td className="px-5 py-2.5 text-sm text-right font-mono text-teal-500">{fmtCurrency(c.revenue)}</td>
                    <td className="px-5 py-2.5 text-sm text-right text-[var(--ff-text-secondary)]">{c.invoiceCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="p-8 text-center text-sm text-[var(--ff-text-tertiary)]">No customer data</div>
          )}
        </div>

        {/* Top 5 Expense Categories */}
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
          <div className="px-5 py-3 border-b border-[var(--ff-border-light)]">
            <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Top 5 Expense Categories</h3>
          </div>
          {(data?.topExpenses?.length ?? 0) > 0 ? (
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)]">
                  <th className="px-5 py-2 text-left text-xs font-medium uppercase text-[var(--ff-text-secondary)]">Account</th>
                  <th className="px-5 py-2 text-right text-xs font-medium uppercase text-[var(--ff-text-secondary)]">Total</th>
                  <th className="px-5 py-2 text-right text-xs font-medium uppercase text-[var(--ff-text-secondary)]">%</th>
                </tr>
              </thead>
              <tbody>
                {(data?.topExpenses ?? []).map((e, i) => (
                  <tr key={i} className="border-b border-[var(--ff-border-light)]/50 last:border-0">
                    <td className="px-5 py-2.5 text-sm text-[var(--ff-text-primary)] truncate max-w-[200px]">{e.accountName}</td>
                    <td className="px-5 py-2.5 text-sm text-right font-mono text-rose-500">{fmtCurrency(e.total)}</td>
                    <td className="px-5 py-2.5 text-sm text-right text-[var(--ff-text-secondary)]">{e.percentOfExpenses.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="p-8 text-center text-sm text-[var(--ff-text-tertiary)]">No expense data</div>
          )}
        </div>
      </div>

      {/* Row 4 — Aging Donut Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* AR Aging */}
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
          <h3 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">AR Aging</h3>
          {(data?.arAging ?? []).some(b => b.value > 0) ? (
            <div className="flex items-center gap-4">
              <ResponsiveContainer width="50%" height={200}>
                <PieChart>
                  <Pie
                    data={data?.arAging ?? []}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                  >
                    {(data?.arAging ?? []).map((_entry, index) => (
                      <Cell key={`ar-${index}`} fill={AGING_COLORS[index % AGING_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ backgroundColor: 'var(--ff-bg-secondary)', border: '1px solid var(--ff-border-light)', borderRadius: '8px', color: 'var(--ff-text-primary)' }}
                    formatter={(value) => [fmtCurrency(Number(value)), '']}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex-1 space-y-2">
                {(data?.arAging ?? []).map((bucket, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: AGING_COLORS[i] }} />
                      <span className="text-xs text-[var(--ff-text-secondary)]">{bucket.name}</span>
                    </div>
                    <span className="text-xs font-mono text-[var(--ff-text-primary)]">{fmtCurrency(bucket.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-[200px] text-[var(--ff-text-tertiary)] text-sm">No outstanding AR</div>
          )}
        </div>

        {/* AP Aging */}
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
          <h3 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">AP Aging</h3>
          {(data?.apAging ?? []).some(b => b.value > 0) ? (
            <div className="flex items-center gap-4">
              <ResponsiveContainer width="50%" height={200}>
                <PieChart>
                  <Pie
                    data={data?.apAging ?? []}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                  >
                    {(data?.apAging ?? []).map((_entry, index) => (
                      <Cell key={`ap-${index}`} fill={AGING_COLORS[index % AGING_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ backgroundColor: 'var(--ff-bg-secondary)', border: '1px solid var(--ff-border-light)', borderRadius: '8px', color: 'var(--ff-text-primary)' }}
                    formatter={(value) => [fmtCurrency(Number(value)), '']}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex-1 space-y-2">
                {(data?.apAging ?? []).map((bucket, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: AGING_COLORS[i] }} />
                      <span className="text-xs text-[var(--ff-text-secondary)]">{bucket.name}</span>
                    </div>
                    <span className="text-xs font-mono text-[var(--ff-text-primary)]">{fmtCurrency(bucket.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-[200px] text-[var(--ff-text-tertiary)] text-sm">No outstanding AP</div>
          )}
        </div>
      </div>

    </div>
  );
}

// =====================================================
// Chart of Accounts Tab
// =====================================================

const SUBTYPES_BY_TYPE: Record<string, { value: string; label: string }[]> = {
  asset: [
    { value: 'bank', label: 'Bank' },
    { value: 'receivable', label: 'Receivable' },
    { value: 'inventory', label: 'Inventory' },
    { value: 'fixed_asset', label: 'Fixed Asset' },
    { value: 'accumulated_depreciation', label: 'Accum. Depreciation' },
    { value: 'other_current_asset', label: 'Other Current Asset' },
    { value: 'other', label: 'Other' },
  ],
  liability: [
    { value: 'payable', label: 'Payable' },
    { value: 'tax', label: 'Tax' },
    { value: 'other_current_liability', label: 'Other Current Liability' },
    { value: 'other', label: 'Other' },
  ],
  equity: [
    { value: 'equity', label: 'Equity' },
    { value: 'retained_earnings', label: 'Retained Earnings' },
    { value: 'other', label: 'Other' },
  ],
  revenue: [
    { value: 'revenue', label: 'Revenue' },
    { value: 'other', label: 'Other' },
  ],
  expense: [
    { value: 'cost_of_sales', label: 'Cost of Sales' },
    { value: 'operating_expense', label: 'Operating Expense' },
    { value: 'other', label: 'Other' },
  ],
};

function ChartOfAccountsTab() {
  const [accounts, setAccounts] = useState<GLAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'flat' | 'tree'>('flat');
  const [filterType, setFilterType] = useState<string>('all');
  const [sidebarType, setSidebarType] = useState<AccountCategoryType>('all');
  const [sidebarPrefix, setSidebarPrefix] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [addForm, setAddForm] = useState({
    accountCode: '',
    accountName: '',
    accountType: 'asset' as GLAccountType,
    accountSubtype: '',
    parentAccountId: '',
    description: '',
  });

  useEffect(() => {
    loadAccounts();
  }, [viewMode, showInactive]);

  const loadAccounts = async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (viewMode === 'tree') params.set('view', 'tree');
      if (showInactive) params.set('includeInactive', 'true');
      const res = await apiFetch(`/api/accounting/chart-of-accounts?${params}`);
      const data = await res.json();
      setAccounts(data.data || data || []);
    } catch (err) {
      log.error('Failed to load accounts', { error: err }, 'accounting-ui');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddAccount = async () => {
    if (!addForm.accountCode || !addForm.accountName) return;
    setIsSaving(true);
    try {
      const normalBalance = (addForm.accountType === 'asset' || addForm.accountType === 'expense') ? 'debit' : 'credit';
      const res = await apiFetch('/api/accounting/chart-of-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          accountCode: addForm.accountCode,
          accountName: addForm.accountName,
          accountType: addForm.accountType,
          accountSubtype: addForm.accountSubtype || undefined,
          parentAccountId: addForm.parentAccountId || undefined,
          description: addForm.description || undefined,
          normalBalance,
        }),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || 'Failed to create account');
      }
      setShowAddForm(false);
      setAddForm({ accountCode: '', accountName: '', accountType: 'asset', accountSubtype: '', parentAccountId: '', description: '' });
      await loadAccounts();
    } catch (err) {
      log.error('Failed to create account', { error: err }, 'accounting-ui');
      alert(err instanceof Error ? err.message : 'Failed to create account');
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdateAccount = async (id: string, data: { accountName: string; description: string; defaultVatCode: string }) => {
    try {
      const res = await apiFetch('/api/accounting/chart-of-accounts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id, ...data }),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || 'Failed to update account');
      }
      await loadAccounts();
    } catch (err) {
      log.error('Failed to update account', { error: err }, 'accounting-ui');
      alert(err instanceof Error ? err.message : 'Failed to update account');
    }
  };

  const handleDeleteAccount = async (id: string) => {
    if (!window.confirm('Deactivate this account? It will be hidden from the chart of accounts.')) return;
    try {
      const res = await apiFetch(`/api/accounting/chart-of-accounts-detail?id=${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || 'Failed to delete account');
      }
      await loadAccounts();
    } catch (err) {
      log.error('Failed to delete account', { error: err }, 'accounting-ui');
      alert(err instanceof Error ? err.message : 'Failed to delete account');
    }
  };

  const baseFiltered = filterType === 'all'
    ? accounts
    : accounts.filter(a => a.accountType === filterType);
  const filteredAccounts = filterAccounts(baseFiltered, sidebarType, sidebarPrefix);

  const accountTypeColor = (type: string) => {
    switch (type) {
      case 'asset': return 'bg-blue-500/20 text-blue-400';
      case 'liability': return 'bg-red-500/20 text-red-400';
      case 'equity': return 'bg-purple-500/20 text-purple-400';
      case 'revenue': return 'bg-teal-500/20 text-teal-400';
      case 'expense': return 'bg-amber-500/20 text-amber-400';
      default: return 'bg-gray-500/20 text-gray-400';
    }
  };

  const subtypes = SUBTYPES_BY_TYPE[addForm.accountType] || [];
  const parentOptions = accounts.filter(a => a.isActive);

  return (
    <div className="flex gap-5">
      {/* Account Category Sidebar (WS-6.2) */}
      <AccountCategorySidebar
        accounts={accounts}
        selectedType={sidebarType}
        searchPrefix={sidebarPrefix}
        onSelectType={setSidebarType}
        onSearchPrefixChange={setSidebarPrefix}
      />

      {/* Main content */}
      <div className="flex-1 min-w-0 space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <select
            value={filterType}
            onChange={e => setFilterType(e.target.value)}
            className="ff-select text-sm py-2 px-3 min-w-[160px]"
          >
            <option value="all">All Types</option>
            <option value="asset">Assets</option>
            <option value="liability">Liabilities</option>
            <option value="equity">Equity</option>
            <option value="revenue">Revenue</option>
            <option value="expense">Expenses</option>
          </select>

          <div className="flex rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <button
              onClick={() => setViewMode('flat')}
              className={`px-3 py-2 text-sm font-medium transition-colors ${
                viewMode === 'flat'
                  ? 'bg-teal-600 text-white'
                  : 'bg-[var(--ff-bg-secondary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
              }`}
            >
              Flat
            </button>
            <button
              onClick={() => setViewMode('tree')}
              className={`px-3 py-2 text-sm font-medium transition-colors ${
                viewMode === 'tree'
                  ? 'bg-teal-600 text-white'
                  : 'bg-[var(--ff-bg-secondary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
              }`}
            >
              Tree
            </button>
          </div>

          <label className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={e => setShowInactive(e.target.checked)}
              className="rounded border-[var(--ff-border-light)]"
            />
            Show inactive
          </label>
        </div>

        <div className="flex items-center gap-3">
          <p className="text-sm text-[var(--ff-text-secondary)]">
            {filteredAccounts.length} account{filteredAccounts.length !== 1 ? 's' : ''}
          </p>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium"
          >
            <Plus className="h-4 w-4" />
            Add Account
          </button>
        </div>
      </div>

      {/* Add Account Form */}
      {showAddForm && (
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-teal-500/30 p-4 space-y-4">
          <h4 className="text-sm font-semibold text-[var(--ff-text-primary)]">New Account</h4>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Code *</label>
              <input
                type="text"
                value={addForm.accountCode}
                onChange={e => setAddForm(f => ({ ...f, accountCode: e.target.value }))}
                placeholder="e.g. 1100"
                className="ff-input w-full text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Name *</label>
              <input
                type="text"
                value={addForm.accountName}
                onChange={e => setAddForm(f => ({ ...f, accountName: e.target.value }))}
                placeholder="e.g. Accounts Receivable"
                className="ff-input w-full text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Type *</label>
              <select
                value={addForm.accountType}
                onChange={e => setAddForm(f => ({ ...f, accountType: e.target.value as GLAccountType, accountSubtype: '' }))}
                className="ff-select w-full text-sm"
              >
                <option value="asset">Asset</option>
                <option value="liability">Liability</option>
                <option value="equity">Equity</option>
                <option value="revenue">Revenue</option>
                <option value="expense">Expense</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Subtype</label>
              <select
                value={addForm.accountSubtype}
                onChange={e => setAddForm(f => ({ ...f, accountSubtype: e.target.value }))}
                className="ff-select w-full text-sm"
              >
                <option value="">None</option>
                {subtypes.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Parent Account</label>
              <select
                value={addForm.parentAccountId}
                onChange={e => setAddForm(f => ({ ...f, parentAccountId: e.target.value }))}
                className="ff-select w-full text-sm"
              >
                <option value="">None (top-level)</option>
                {parentOptions.map(a => (
                  <option key={a.id} value={a.id}>{a.accountCode} - {a.accountName}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Description</label>
              <input
                type="text"
                value={addForm.description}
                onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Optional description"
                className="ff-input w-full text-sm"
              />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-[var(--ff-text-tertiary)]">
              Normal balance: <span className="font-medium">{addForm.accountType === 'asset' || addForm.accountType === 'expense' ? 'Debit' : 'Credit'}</span> (auto-set from type)
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowAddForm(false)}
                className="px-3 py-2 text-sm font-medium text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAddAccount}
                disabled={isSaving || !addForm.accountCode || !addForm.accountName}
                className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium disabled:opacity-50"
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {isSaving ? 'Creating...' : 'Create Account'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[var(--ff-bg-tertiary)] border-b border-[var(--ff-border-light)]">
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Code</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Account Name</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Type</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Normal Balance</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">VAT Default</th>
                  <th className="px-6 py-3 text-center text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">System</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredAccounts.map(account => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    level={0}
                    viewMode={viewMode}
                    accountTypeColor={accountTypeColor}
                    onUpdate={handleUpdateAccount}
                    onDelete={handleDeleteAccount}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

function AccountRow({
  account,
  level,
  viewMode,
  accountTypeColor,
  onUpdate,
  onDelete,
}: {
  account: GLAccount;
  level: number;
  viewMode: string;
  accountTypeColor: (type: string) => string;
  onUpdate: (id: string, data: { accountName: string; description: string; defaultVatCode: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(account.accountName);
  const [editDesc, setEditDesc] = useState(account.description || '');
  const [editVatCode, setEditVatCode] = useState<string>(account.defaultVatCode || 'none');
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    setIsSaving(true);
    await onUpdate(account.id, { accountName: editName, description: editDesc, defaultVatCode: editVatCode });
    setIsSaving(false);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditName(account.accountName);
    setEditDesc(account.description || '');
    setEditVatCode(account.defaultVatCode || 'none');
    setIsEditing(false);
  };

  const indent = viewMode === 'tree' ? `${level * 1.5}rem` : '0';

  return (
    <>
      <tr className={`border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)] transition-colors ${!account.isActive ? 'opacity-50' : ''}`}>
        <td className="px-6 py-3 text-sm font-mono font-medium text-[var(--ff-text-primary)]">
          <span style={{ paddingLeft: indent }}>{account.accountCode}</span>
        </td>
        <td className="px-6 py-3 text-sm text-[var(--ff-text-primary)]">
          {isEditing ? (
            <div className="space-y-1" style={{ paddingLeft: indent }}>
              <input
                type="text"
                value={editName}
                onChange={e => setEditName(e.target.value)}
                className="ff-input w-full text-sm"
                autoFocus
              />
              <input
                type="text"
                value={editDesc}
                onChange={e => setEditDesc(e.target.value)}
                placeholder="Description (optional)"
                className="ff-input w-full text-xs"
              />
              <select
                value={editVatCode}
                onChange={e => setEditVatCode(e.target.value)}
                className="ff-select w-full text-xs"
                title="Default VAT type for transactions posted to this account"
              >
                <option value="none">No VAT (default)</option>
                <option value="standard">Standard 15%</option>
                <option value="zero_rated">Zero Rated</option>
                <option value="exempt">Exempt</option>
              </select>
            </div>
          ) : (
            <div style={{ paddingLeft: indent }}>
              <span>{account.accountName}</span>
              {!account.isActive && (
                <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-500/20 text-gray-400">
                  Inactive
                </span>
              )}
              {account.description && (
                <p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">{account.description}</p>
              )}
            </div>
          )}
        </td>
        <td className="px-6 py-3">
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium uppercase ${accountTypeColor(account.accountType)}`}>
            {account.accountType}
          </span>
        </td>
        <td className="px-6 py-3 text-sm text-[var(--ff-text-secondary)] capitalize">
          {account.normalBalance}
        </td>
        <td className="px-6 py-3 text-sm">
          {account.defaultVatCode && account.defaultVatCode !== 'none'
            ? <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/10 text-blue-400">
                {{ standard: '15%', zero_rated: 'Zero Rated', exempt: 'Exempt' }[account.defaultVatCode] ?? account.defaultVatCode}
              </span>
            : <span className="text-[var(--ff-text-tertiary)] text-xs">—</span>}
        </td>
        <td className="px-6 py-3 text-center">
          {account.isSystemAccount && (
            <Lock className="h-4 w-4 text-[var(--ff-text-tertiary)] mx-auto" />
          )}
        </td>
        <td className="px-6 py-3 text-right">
          {account.isSystemAccount ? null : isEditing ? (
            <div className="flex items-center justify-end gap-1">
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="p-1.5 rounded text-teal-400 hover:bg-teal-500/10 transition-colors disabled:opacity-50"
                title="Save"
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              </button>
              <button
                onClick={handleCancel}
                className="p-1.5 rounded text-[var(--ff-text-tertiary)] hover:bg-[var(--ff-bg-tertiary)] transition-colors"
                title="Cancel"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-1">
              <button
                onClick={() => { setIsEditing(true); setEditName(account.accountName); setEditDesc(account.description || ''); }}
                className="p-1.5 rounded text-[var(--ff-text-tertiary)] hover:text-blue-400 hover:bg-blue-500/10 transition-colors"
                title="Edit"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                onClick={() => onDelete(account.id)}
                className="p-1.5 rounded text-[var(--ff-text-tertiary)] hover:text-red-400 hover:bg-red-500/10 transition-colors"
                title="Deactivate"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          )}
        </td>
      </tr>
      {viewMode === 'tree' && account.children?.map(child => (
        <AccountRow
          key={child.id}
          account={child}
          level={level + 1}
          viewMode={viewMode}
          accountTypeColor={accountTypeColor}
          onUpdate={onUpdate}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}

// =====================================================
// Journal Entries Tab
// =====================================================

function JournalEntriesTab() {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const { displayMode, setDisplayMode } = useDisplayMode();

  useEffect(() => {
    loadEntries();
  }, [statusFilter]);

  const loadEntries = async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const res = await apiFetch(`/api/accounting/journal-entries?${params}`);
      const data = await res.json();
      const payload = data.data || data;
      setEntries(payload.entries || payload || []);
    } catch (err) {
      log.error('Failed to load journal entries', { error: err }, 'accounting-ui');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="ff-select text-sm py-2 px-3 min-w-[160px]"
          >
            <option value="all">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="posted">Posted</option>
            <option value="reversed">Reversed</option>
          </select>
          <DisplayModeToggle value={displayMode} onChange={setDisplayMode} />
        </div>
        <Link
          href="/accounting/journal-entries/new"
          className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium"
        >
          <Plus className="h-4 w-4" />
          New Entry
        </Link>
      </div>

      {/* Table */}
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" />
          </div>
        ) : entries.length === 0 ? (
          <div className="p-8 text-center">
            <FileSpreadsheet className="h-8 w-8 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
            <p className="text-[var(--ff-text-secondary)]">No journal entries found</p>
            <Link
              href="/accounting/journal-entries/new"
              className="inline-flex items-center gap-2 mt-3 text-sm text-teal-600 hover:text-teal-700 font-medium"
            >
              <Plus className="h-4 w-4" />
              Create your first entry
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[var(--ff-bg-tertiary)] border-b border-[var(--ff-border-light)]">
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Entry #</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Date</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Description</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Source</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Status</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(entry => (
                  <tr key={entry.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                    <td className="px-6 py-3">
                      <Link href={`/accounting/journal-entries/${entry.id}`} className="text-sm font-medium text-teal-600 hover:text-teal-700">
                        {entry.entryNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-3 text-sm text-[var(--ff-text-primary)]">
                      {new Date(entry.entryDate).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-3 text-sm text-[var(--ff-text-primary)] max-w-xs truncate">
                      {entry.description || '-'}
                    </td>
                    <td className="px-6 py-3">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-500/20 text-[var(--ff-text-secondary)]">
                        {entry.source}
                      </span>
                    </td>
                    <td className="px-6 py-3">
                      <StatusBadge status={entry.status} />
                    </td>
                    <td className="px-6 py-3 text-right">
                      <Link
                        href={`/accounting/journal-entries/${entry.id}`}
                        className="text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
                      >
                        <ChevronRight className="h-4 w-4 inline" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// =====================================================
// Fiscal Periods Tab
// =====================================================

function FiscalPeriodsTab() {
  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    loadPeriods();
  }, []);

  const loadPeriods = async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/accounting/fiscal-periods');
      const data = await res.json();
      setPeriods(data.data || data || []);
    } catch (err) {
      log.error('Failed to load fiscal periods', { error: err }, 'accounting-ui');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePeriodAction = async (periodId: string, action: 'close' | 'lock' | 'reopen') => {
    setActionLoading(periodId);
    try {
      const res = await apiFetch('/api/accounting/fiscal-periods-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id: periodId, action }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Action failed');
      }
      await loadPeriods();
    } catch (err) {
      log.error('Fiscal period action failed', { error: err, periodId, action }, 'accounting-ui');
    } finally {
      setActionLoading(null);
    }
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'open': return <CheckCircle2 className="h-4 w-4 text-teal-500" />;
      case 'closing': return <Clock className="h-4 w-4 text-amber-500" />;
      case 'closed': return <Lock className="h-4 w-4 text-blue-500" />;
      case 'locked': return <Lock className="h-4 w-4 text-red-500" />;
      default: return null;
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'open': return 'bg-teal-500/20 text-teal-400';
      case 'closing': return 'bg-amber-500/20 text-amber-400';
      case 'closed': return 'bg-blue-500/20 text-blue-400';
      case 'locked': return 'bg-red-500/20 text-red-400';
      default: return 'bg-gray-500/20 text-gray-400';
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[var(--ff-bg-tertiary)] border-b border-[var(--ff-border-light)]">
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Period</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Year</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Start Date</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">End Date</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Status</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {periods.map(period => (
                  <tr key={period.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                    <td className="px-6 py-3 text-sm font-medium text-[var(--ff-text-primary)]">{period.periodName}</td>
                    <td className="px-6 py-3 text-sm text-[var(--ff-text-secondary)]">{period.fiscalYear}</td>
                    <td className="px-6 py-3 text-sm text-[var(--ff-text-primary)]">{new Date(period.startDate).toLocaleDateString()}</td>
                    <td className="px-6 py-3 text-sm text-[var(--ff-text-primary)]">{new Date(period.endDate).toLocaleDateString()}</td>
                    <td className="px-6 py-3">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium uppercase ${statusColor(period.status)}`}>
                        {statusIcon(period.status)}
                        {period.status}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {period.status === 'open' && (
                          <button
                            onClick={() => handlePeriodAction(period.id, 'close')}
                            disabled={actionLoading === period.id}
                            className="px-3 py-1 text-xs font-medium rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors disabled:opacity-50"
                          >
                            {actionLoading === period.id ? 'Closing...' : 'Close'}
                          </button>
                        )}
                        {period.status === 'closed' && (
                          <>
                            <button
                              onClick={() => handlePeriodAction(period.id, 'lock')}
                              disabled={actionLoading === period.id}
                              className="px-3 py-1 text-xs font-medium rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-50"
                            >
                              Lock
                            </button>
                            <button
                              onClick={() => handlePeriodAction(period.id, 'reopen')}
                              disabled={actionLoading === period.id}
                              className="px-3 py-1 text-xs font-medium rounded bg-teal-500/20 text-teal-400 hover:bg-teal-500/30 transition-colors disabled:opacity-50"
                            >
                              Reopen
                            </button>
                          </>
                        )}
                        {period.status === 'locked' && (
                          <span className="text-xs text-[var(--ff-text-tertiary)]">Locked</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// =====================================================
// Reports Tab
// =====================================================

function ReportsTab() {
  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState<string>('');
  const [trialBalance, setTrialBalance] = useState<TrialBalanceRow[]>([]);
  const [totals, setTotals] = useState({ debit: 0, credit: 0 });
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    loadPeriods();
  }, []);

  const loadPeriods = async () => {
    try {
      const res = await apiFetch('/api/accounting/fiscal-periods');
      const data = await res.json();
      const list = data.data || data || [];
      setPeriods(list);
      const current = list.find((p: FiscalPeriod) => p.status === 'open');
      if (current) setSelectedPeriod(current.id);
    } catch (err) {
      log.error('Failed to load periods for reports', { error: err }, 'accounting-ui');
    }
  };

  const loadTrialBalance = async () => {
    if (!selectedPeriod) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/reports-trial-balance?fiscal_period_id=${selectedPeriod}`);
      const data = await res.json();
      const payload = data.data || data;
      setTrialBalance(payload.rows || []);
      setTotals({ debit: payload.totalDebit || 0, credit: payload.totalCredit || 0 });
    } catch (err) {
      log.error('Failed to load trial balance', { error: err }, 'accounting-ui');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (selectedPeriod) loadTrialBalance();
  }, [selectedPeriod]);

  const formatCurrency = (amount: number) =>
    amount === 0 ? '-' : `R ${Number(amount).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="space-y-6">
      {/* Report Navigation */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Link href="/accounting/reports/income-statement" className="p-4 rounded-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] hover:border-teal-500/50 transition-all no-underline">
          <p className="font-medium text-sm text-[var(--ff-text-primary)]">Income Statement</p>
          <p className="text-xs text-[var(--ff-text-tertiary)]">Profit & Loss</p>
        </Link>
        <Link href="/accounting/reports/balance-sheet" className="p-4 rounded-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] hover:border-blue-500/50 transition-all no-underline">
          <p className="font-medium text-sm text-[var(--ff-text-primary)]">Balance Sheet</p>
          <p className="text-xs text-[var(--ff-text-tertiary)]">Assets = L + E</p>
        </Link>
        <Link href="/accounting/reports/vat-return" className="p-4 rounded-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] hover:border-amber-500/50 transition-all no-underline">
          <p className="font-medium text-sm text-[var(--ff-text-primary)]">VAT Return</p>
          <p className="text-xs text-[var(--ff-text-tertiary)]">Input / Output VAT</p>
        </Link>
        <Link href="/accounting/reports/project-profitability" className="p-4 rounded-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] hover:border-purple-500/50 transition-all no-underline">
          <p className="font-medium text-sm text-[var(--ff-text-primary)]">Project Profitability</p>
          <p className="text-xs text-[var(--ff-text-tertiary)]">Revenue vs costs</p>
        </Link>
      </div>

      {/* Period Selector */}
      <div className="flex items-center gap-4">
        <label className="text-sm font-medium text-[var(--ff-text-primary)]">Fiscal Period:</label>
        <select
          value={selectedPeriod}
          onChange={e => setSelectedPeriod(e.target.value)}
          className="ff-select text-sm py-2 px-3 min-w-[200px]"
        >
          <option value="">Select period...</option>
          {periods.map(p => (
            <option key={p.id} value={p.id}>{p.periodName} ({p.fiscalYear})</option>
          ))}
        </select>
      </div>

      {/* Trial Balance */}
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
        <div className="px-6 py-4 border-b border-[var(--ff-border-light)]">
          <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">Trial Balance</h3>
        </div>

        {!selectedPeriod ? (
          <div className="p-8 text-center">
            <BarChart3 className="h-8 w-8 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
            <p className="text-[var(--ff-text-secondary)]">Select a fiscal period to view the trial balance</p>
          </div>
        ) : isLoading ? (
          <div className="p-8 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" />
          </div>
        ) : trialBalance.length === 0 ? (
          <div className="p-8 text-center">
            <BarChart3 className="h-8 w-8 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
            <p className="text-[var(--ff-text-secondary)]">No balances found for this period</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[var(--ff-bg-tertiary)] border-b border-[var(--ff-border-light)]">
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Code</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Account</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Type</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Debit</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Credit</th>
                </tr>
              </thead>
              <tbody>
                {trialBalance.map(row => (
                  <tr key={row.accountCode} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                    <td className="px-6 py-3 text-sm font-mono text-[var(--ff-text-primary)]">{row.accountCode}</td>
                    <td className="px-6 py-3 text-sm text-[var(--ff-text-primary)]">{row.accountName}</td>
                    <td className="px-6 py-3 text-sm text-[var(--ff-text-secondary)] capitalize">{row.accountType}</td>
                    <td className="px-6 py-3 text-sm text-right font-medium text-[var(--ff-text-primary)]">
                      {formatCurrency(row.debitBalance)}
                    </td>
                    <td className="px-6 py-3 text-sm text-right font-medium text-[var(--ff-text-primary)]">
                      {formatCurrency(row.creditBalance)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-[var(--ff-bg-tertiary)] border-t-2 border-[var(--ff-border-medium)]">
                  <td colSpan={3} className="px-6 py-3 text-sm font-semibold text-[var(--ff-text-primary)]">Total</td>
                  <td className="px-6 py-3 text-sm text-right font-bold text-[var(--ff-text-primary)]">{formatCurrency(totals.debit)}</td>
                  <td className="px-6 py-3 text-sm text-right font-bold text-[var(--ff-text-primary)]">{formatCurrency(totals.credit)}</td>
                </tr>
                {totals.debit !== totals.credit && (
                  <tr className="bg-red-500/10">
                    <td colSpan={3} className="px-6 py-2 text-xs font-medium text-red-400 flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      Out of balance
                    </td>
                    <td colSpan={2} className="px-6 py-2 text-xs text-right text-red-400">
                      Difference: {formatCurrency(Math.abs(totals.debit - totals.credit))}
                    </td>
                  </tr>
                )}
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// =====================================================
// Shared Components
// =====================================================

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-amber-500/20 text-amber-400',
    posted: 'bg-teal-500/20 text-teal-400',
    reversed: 'bg-red-500/20 text-red-400',
    voided: 'bg-gray-500/20 text-gray-400',
  };

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium uppercase ${colors[status] || colors.draft}`}>
      {status}
    </span>
  );
}
