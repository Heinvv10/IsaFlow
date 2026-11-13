/**
 * Overview tab: the dashboard. One KPI row, one "Needs attention" list, quick
 * actions, then charts.
 */

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {
  Plus, BarChart3, Landmark, FileText, CreditCard, TrendingUp,
  BookOpen, FileSpreadsheet, Calculator, Calendar, ArrowRight,
} from 'lucide-react';
import { Users, Upload } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { PAGE_REGISTRY, DEFAULT_QUICK_ACTIONS, type PageMeta } from '@/modules/accounting/constants/pageRegistry';
import { OverviewTables } from './OverviewTables';
import { OverviewKpiCards } from './OverviewKpiCards';
import { Skeleton } from '@/components/ui/Skeleton';
import { NeedsAttention } from './NeedsAttention';
import { NoBankAccountWarning } from '@/components/accounting/banking/NoBankAccountWarning';
import { formatMoney, formatMoneyCompact } from '@/lib/money/formatMoney';
import type { HeadlineFigures } from '@/modules/accounting/services/reports/headlineFigures';
import type { AttentionItem } from '@/modules/accounting/services/dashboard/attentionShape';

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

export interface KPIData {
  kpis: {
    revenue: { total: number; priorTotal: number; changePercent: number };
    revenueMtd: number;
    expenses: { total: number; priorTotal: number };
    netProfit: { amount: number; margin: number | null };
    cash: { total: number; priorTotal: number; change: number };
    receivables: { total: number; overdue: number; overdueDisputed: number; avgDebtorDays: number };
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
  /** The headline figures (reports/headlineFigures): the one definition the KPI row and Month-End read. */
  headline: HeadlineFigures;
  /** The window `kpis.revenue` and `kpis.netProfit` span. */
  period: { from: string; to: string };
}

const ICON_MAP: Record<string, React.ElementType> = {
  Plus, BarChart3, Landmark, FileText, CreditCard, TrendingUp,
  BookOpen, FileSpreadsheet, Calculator, Calendar, Users, Upload,
};

function fmtCurrency(n: number): string {
  return formatMoney(n);
}

const fmtCompact = (n: number): string => formatMoneyCompact(n);

/**
 * The kpi-dashboard load a parent already made (pages/accounting/index.tsx), so Home fetches it once.
 *
 * The load lives in the page, not here, on purpose: switching tabs does not
 * refetch the figures. They are reloaded when the company changes (the page's
 * effect), not on re-entering Overview.
 */
export interface KpiLoad { data: KPIData | null; error: string; loading: boolean }

/**
 * `setupOpen`: setup tasks are still open, so NeedsAttention must not say "All caught up!".
 * `setupUnknown`: the setup checklist has not resolved (timed out or failed), so NeedsAttention says neither.
 */
export function OverviewTab({ setupOpen = false, setupUnknown = false, kpiLoad, onRetry }: { setupOpen?: boolean; setupUnknown?: boolean; kpiLoad?: KpiLoad; onRetry?: () => void }) {
  const [ownData, setData] = useState<KPIData | null>(null);
  const [ownLoading, setIsLoading] = useState(!kpiLoad);
  const data = kpiLoad ? kpiLoad.data : ownData;
  const isLoading = kpiLoad ? kpiLoad.loading : ownLoading;
  /** Fixed at mount: a parent that supplies the load supplies it for good. */
  const fetchOwn = useRef(!kpiLoad);
  const [kpiError, setKpiError] = useState('');
  const [provisionalCount, setProvisionalCount] = useState<number | null>(null);
  const [missingInvoiceCount, setMissingInvoiceCount] = useState<number | null>(null);
  const [quickActions, setQuickActions] = useState<PageMeta[]>(
    DEFAULT_QUICK_ACTIONS.map(p => PAGE_REGISTRY[p]).filter((p): p is PageMeta => !!p)
  );

  useEffect(() => {
    if (fetchOwn.current) void loadKPIData();
    void loadQuickActions();
    apiFetch('/api/accounting/provisional/outstanding')
      .then(async r => { await assertOk(r, 'Could not load the provisional entry count - try again'); return r.json(); })
      .then((json: { data?: unknown[] }) => setProvisionalCount((json.data ?? []).length))
      .catch(err => setKpiError(apiErrorMessage(err, 'Could not load the provisional entry count - try again')));
    apiFetch('/api/accounting/expected-invoice-alerts?status=pending')
      .then(async r => { await assertOk(r, 'Could not load the missing invoice alerts - try again'); return r.json(); })
      .then((json: { data?: unknown[] }) => setMissingInvoiceCount((json.data ?? []).length))
      .catch(err => setKpiError(apiErrorMessage(err, 'Could not load the missing invoice alerts - try again')));
  }, []);

  const loadKPIData = async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/accounting/kpi-dashboard', { credentials: 'include' }); await assertOk(res, 'Could not load the dashboard figures - try again');
      const json = await res.json();
      setData(json.data || json);
    } catch (err) {
      setData(null); log.error('Failed to load KPI data', { error: err }, 'accounting-ui');
      setKpiError(apiErrorMessage(err, 'Could not load the dashboard figures - try again'));
    } finally {
      setIsLoading(false);
    }
  };

  const loadQuickActions = async () => {
    try {
      const res = await apiFetch('/api/accounting/page-visits?limit=6', { credentials: 'include' });
      await assertOk(res, 'Could not load quick actions'); const json = await res.json();
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

  // The two client-side rows of the one attention list.
  const extra: AttentionItem[] = [];
  if (provisionalCount !== null && provisionalCount > 0) {
    extra.push({
      key: 'provisional', area: 'Banking', severity: 'due_soon', href: '/accounting/bank/provisional',
      label: `${provisionalCount} provisional entr${provisionalCount === 1 ? 'y' : 'ies'} awaiting evidence`,
      detail: 'Posted from the bank statement without a slip. Attach documents to confirm.',
    });
  }
  if (missingInvoiceCount !== null && missingInvoiceCount > 0) {
    extra.push({
      key: 'missing-invoices', area: 'Purchases', severity: missingInvoiceCount >= 3 ? 'overdue' : 'due_soon',
      href: '/accounting/suppliers/missing-invoices',
      label: `${missingInvoiceCount} expected supplier invoice${missingInvoiceCount === 1 ? '' : 's'} not received`,
      detail: 'Chase the supplier or resolve the alert.',
    });
  }

  if (isLoading) {
    return (
      <div className="space-y-6" aria-busy="true">
        <Skeleton variant="card" height="96px" />
        <Skeleton variant="card" height="160px" />
        <Skeleton variant="card" height="96px" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {kpiError && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{kpiError}</div>}
      <OverviewKpiCards
        headline={data?.headline}
        overdueDisputed={kpis?.receivables.overdueDisputed}
        onRetry={onRetry ?? (fetchOwn.current ? () => void loadKPIData() : undefined)}
      />

      {/* No bank account warning: shown when the cash figure is non-zero but no bank account is configured */}
      {data !== null && !data.hasBankAccount && (data.headline?.cash ?? 0) !== 0 && (
        <NoBankAccountWarning />
      )}

      <NeedsAttention setupOpen={setupOpen} setupUnknown={setupUnknown} extra={extra} />

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

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
          <h3 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">Revenue vs Expenses</h3>
          {(data?.revenueChart?.length ?? 0) > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={data?.revenueChart ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--ff-border-light)" />
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: 'var(--ff-text-secondary)' }} />
                <YAxis tick={{ fontSize: 12, fill: 'var(--ff-text-secondary)' }} tickFormatter={(v) => fmtCompact(Number(v))} />
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
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: 'var(--ff-text-secondary)' }} />
                <YAxis tick={{ fontSize: 12, fill: 'var(--ff-text-secondary)' }} tickFormatter={(v) => fmtCompact(Number(v))} />
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
