/**
 * Overview Tab — KPI Dashboard with charts and quick actions
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {
  Plus, BarChart3, Landmark, FileText, CreditCard, TrendingUp,
  BookOpen, FileSpreadsheet, Calculator, Calendar, Loader2, ArrowRight, DollarSign,
  ArrowDown, Clock, AlertCircle,
} from 'lucide-react';
import { Users, Upload } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { PAGE_REGISTRY, DEFAULT_QUICK_ACTIONS, type PageMeta } from '@/modules/accounting/constants/pageRegistry';
import { OverviewTables } from './OverviewTables';
import { TodoWidget } from './TodoWidget';
import { WorkbenchSection } from './WorkbenchSection';
import { NoBankAccountWarning } from '@/components/accounting/banking/NoBankAccountWarning';

const LineChart = dynamic(() => import('recharts').then(m => m.LineChart), { ssr: false });
const Line = dynamic(() => import('recharts').then(m => m.Line), { ssr: false });
const BarChart = dynamic(() => import('recharts').then(m => m.BarChart), { ssr: false });
const Bar = dynamic(() => import('recharts').then(m => m.Bar), { ssr: false });
const XAxis = dynamic(() => import('recharts').then(m => m.XAxis), { ssr: false });
const YAxis = dynamic(() => import('recharts').then(m => m.YAxis), { ssr: false });
const CartesianGrid = dynamic(() => import('recharts').then(m => m.CartesianGrid), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then(m => m.Tooltip), { ssr: false });
const Legend = dynamic(() => import('recharts').then(m => m.Legend), { ssr: false });
const ResponsiveContainer = dynamic(() => import('recharts').then(m => m.ResponsiveContainer), { ssr: false });

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
  hasBankAccount: boolean;
}

const ICON_MAP: Record<string, React.ElementType> = {
  Plus, BarChart3, Landmark, FileText, CreditCard, TrendingUp,
  BookOpen, FileSpreadsheet, Calculator, Calendar, Users, Upload,
};

function fmtCurrency(n: number): string {
  return 'R ' + new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function fmtCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return 'R ' + (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return 'R ' + (n / 1_000).toFixed(1) + 'K';
  return fmtCurrency(n);
}

export function OverviewTab() {
  const [data, setData] = useState<KPIData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [provisionalCount, setProvisionalCount] = useState<number | null>(null);
  const [missingInvoiceCount, setMissingInvoiceCount] = useState<number | null>(null);
  const [quickActions, setQuickActions] = useState<PageMeta[]>(
    DEFAULT_QUICK_ACTIONS.map(p => PAGE_REGISTRY[p]).filter((p): p is PageMeta => !!p)
  );

  useEffect(() => {
    void loadKPIData();
    void loadQuickActions();
    apiFetch('/api/accounting/provisional/outstanding')
      .then(r => r.json())
      .then((json: { data?: unknown[] }) => setProvisionalCount((json.data ?? []).length))
      .catch(() => { /* non-critical */ });
    apiFetch('/api/accounting/expected-invoice-alerts?status=pending')
      .then(r => r.json())
      .then((json: { data?: unknown[] }) => setMissingInvoiceCount((json.data ?? []).length))
      .catch(() => { /* non-critical */ });
  }, []);

  const loadKPIData = async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/accounting/kpi-dashboard', { credentials: 'include' });
      const json = await res.json();
      setData(json.data || json);
    } catch (err) {
      log.error('Failed to load KPI data', { error: err }, 'accounting-ui');
    } finally {
      setIsLoading(false);
    }
  };

  const loadQuickActions = async () => {
    try {
      const res = await apiFetch('/api/accounting/page-visits?limit=6', { credentials: 'include' });
      const json = await res.json();
      const rows = (json.data || []) as { page_path: string }[];
      const tracked = rows.map(r => PAGE_REGISTRY[r.page_path]).filter((p): p is PageMeta => !!p);
      if (tracked.length >= 6) {
        setQuickActions(tracked.slice(0, 6));
      } else if (tracked.length > 0) {
        const seen = new Set(tracked.map(t => t.path));
        const fill = DEFAULT_QUICK_ACTIONS
          .filter(p => !seen.has(p))
          .map(p => PAGE_REGISTRY[p])
          .filter((p): p is PageMeta => !!p);
        setQuickActions([...tracked, ...fill].slice(0, 6));
      }
    } catch (err) {
      // keep defaults
      log.error('Failed to load quick actions', { error: err }, 'accounting-ui');
    }
  };

  const kpis = data?.kpis;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Workbench — exception-first signals for accountants */}
      <WorkbenchSection />

      {/* Action Items */}
      <TodoWidget />

      {/* Quick Actions — unified teal chip for visual cohesion on the dashboard */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {quickActions.map(action => {
          const Icon = ICON_MAP[action.icon] || Plus;
          return (
            <Link
              key={action.path}
              href={action.path}
              className="flex items-center gap-3 p-4 bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] hover:border-teal-500/50 hover:shadow-md transition-all group no-underline"
            >
              <div className="p-2 rounded-lg bg-teal-500/10"><Icon className="h-5 w-5 text-teal-500" /></div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-[var(--ff-text-primary)]">{action.title}</p>
                <p className="text-sm text-[var(--ff-text-secondary)]">{action.description}</p>
              </div>
              <ArrowRight className="h-4 w-4 text-[var(--ff-text-tertiary)] group-hover:text-teal-500 transition-colors" />
            </Link>
          );
        })}
      </div>

      {/* Provisional entries alert card */}
      {provisionalCount !== null && provisionalCount > 0 && (
        <Link href="/accounting/bank/provisional"
          className="flex items-center gap-4 p-4 bg-amber-900/20 border border-amber-500/30 rounded-lg hover:border-amber-500/60 hover:shadow-md transition-all no-underline group">
          <div className="p-2 rounded-lg bg-amber-500/10 shrink-0">
            <Clock className="h-5 w-5 text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-amber-300">Provisional entries awaiting evidence: {provisionalCount}</p>
            <p className="text-xs text-amber-400/70">Bank-first AI posts without slips — attach documents to confirm</p>
          </div>
          <ArrowRight className="h-4 w-4 text-amber-400/60 group-hover:text-amber-400 transition-colors shrink-0" />
        </Link>
      )}

      {/* Missing invoices alert card */}
      {missingInvoiceCount !== null && missingInvoiceCount > 0 && (
        <Link href="/accounting/suppliers/missing-invoices"
          className={`flex items-center gap-4 p-4 rounded-lg hover:shadow-md transition-all no-underline group border ${missingInvoiceCount >= 3 ? 'bg-red-900/20 border-red-500/30 hover:border-red-500/60' : 'bg-amber-900/20 border-amber-500/30 hover:border-amber-500/60'}`}>
          <div className={`p-2 rounded-lg shrink-0 ${missingInvoiceCount >= 3 ? 'bg-red-500/10' : 'bg-amber-500/10'}`}>
            <AlertCircle className={`h-5 w-5 ${missingInvoiceCount >= 3 ? 'text-red-400' : 'text-amber-400'}`} />
          </div>
          <div className="flex-1 min-w-0">
            <p className={`font-semibold ${missingInvoiceCount >= 3 ? 'text-red-300' : 'text-amber-300'}`}>
              Missing invoices overdue: {missingInvoiceCount}
            </p>
            <p className={`text-xs ${missingInvoiceCount >= 3 ? 'text-red-400/70' : 'text-amber-400/70'}`}>
              Supplier invoices expected but not yet received — chase or resolve
            </p>
          </div>
          <ArrowRight className={`h-4 w-4 transition-colors shrink-0 ${missingInvoiceCount >= 3 ? 'text-red-400/60 group-hover:text-red-400' : 'text-amber-400/60 group-hover:text-amber-400'}`} />
        </Link>
      )}

      {/* No bank account warning — shown when cash KPI is non-zero but no bank account configured */}
      {data !== null && !data.hasBankAccount && (kpis?.cash.total ?? 0) !== 0 && (
        <NoBankAccountWarning />
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]">Gross Profit</span>
            <DollarSign className="h-4 w-4 text-teal-500" />
          </div>
          <p className="text-2xl font-bold text-[var(--ff-text-primary)]">{fmtCompact(kpis?.grossProfit.amount ?? 0)}</p>
          <p className="text-xs mt-1 text-[var(--ff-text-tertiary)]">Margin: {(kpis?.grossProfit.margin ?? 0).toFixed(1)}%</p>
        </div>
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]">Cash Position</span>
            <Landmark className="h-4 w-4 text-teal-500" />
          </div>
          <p className={`text-2xl font-bold flex items-center gap-1.5 ${(kpis?.cash.total ?? 0) < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-[var(--ff-text-primary)]'}`}>
            {(kpis?.cash.total ?? 0) < 0 && <ArrowDown className="h-5 w-5" aria-label="Negative" />}
            {fmtCompact(kpis?.cash.total ?? 0)}
          </p>
          <p className={`text-xs mt-1 ${(kpis?.cash.change ?? 0) >= 0 ? 'text-teal-500' : 'text-rose-500'}`}>
            {(kpis?.cash.change ?? 0) >= 0 ? '+' : ''}{fmtCompact(kpis?.cash.change ?? 0)} change
          </p>
        </div>
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]">Outstanding AR</span>
            <CreditCard className="h-4 w-4 text-teal-500" />
          </div>
          <p className="text-2xl font-bold text-[var(--ff-text-primary)]">{fmtCompact(kpis?.receivables.total ?? 0)}</p>
          {(kpis?.receivables.overdue ?? 0) > 0
            ? <p className="text-xs mt-1 text-rose-500">{fmtCompact(kpis?.receivables.overdue ?? 0)} overdue</p>
            : <p className="text-xs mt-1 text-teal-500">No overdue</p>}
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
          <h3 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">Revenue vs Expenses</h3>
          {(data?.revenueChart?.length ?? 0) > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={data?.revenueChart ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--ff-border-light)" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--ff-text-secondary)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--ff-text-secondary)' }} tickFormatter={(v) => fmtCompact(Number(v))} />
                <Tooltip contentStyle={{ backgroundColor: 'var(--ff-bg-secondary)', border: '1px solid var(--ff-border-light)', borderRadius: '8px', color: 'var(--ff-text-primary)' }} formatter={(value) => [fmtCurrency(Number(value)), '']} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="revenue" name="Revenue" stroke="#14b8a6" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="expenses" name="Expenses" stroke="#f43f5e" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[260px] text-[var(--ff-text-tertiary)] text-sm">No data available</div>
          )}
        </div>
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
          <h3 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">Cash Flow</h3>
          {(data?.cashFlowChart?.length ?? 0) > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data?.cashFlowChart ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--ff-border-light)" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--ff-text-secondary)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--ff-text-secondary)' }} tickFormatter={(v) => fmtCompact(Number(v))} />
                <Tooltip contentStyle={{ backgroundColor: 'var(--ff-bg-secondary)', border: '1px solid var(--ff-border-light)', borderRadius: '8px', color: 'var(--ff-text-primary)' }} formatter={(value) => [fmtCurrency(Number(value)), '']} />
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

      {/* Tables and Aging — delegated to OverviewTables */}
      <OverviewTables
        topCustomers={data?.topCustomers ?? []}
        topExpenses={data?.topExpenses ?? []}
        arAging={data?.arAging ?? []}
        apAging={data?.apAging ?? []}
      />
    </div>
  );
}
