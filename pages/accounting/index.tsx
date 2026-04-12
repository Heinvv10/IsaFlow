/**
 * Accounting Module — thin shell with tab routing
 * Tab content lives in src/components/accounting/dashboard/
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import Link from 'next/link';
import {
  Calculator, BookOpen, FileSpreadsheet, Calendar, BarChart3, Plus, Loader2, Settings2,
} from 'lucide-react';
import { OverviewTab } from '@/components/accounting/dashboard/OverviewTab';
import { ChartOfAccountsTab } from '@/components/accounting/dashboard/ChartOfAccountsTab';
import { JournalEntriesTab } from '@/components/accounting/dashboard/JournalEntriesTab';
import { FiscalPeriodsTab } from '@/components/accounting/dashboard/FiscalPeriodsTab';
import { ReportsTab } from '@/components/accounting/dashboard/ReportsTab';
import { DashboardHero, type DashboardHeroStats } from '@/components/accounting/dashboard/DashboardHero';
import { WidgetGrid } from '@/components/dashboard/WidgetGrid';
import { type WidgetConfig, DEFAULT_WIDGET_LAYOUT } from '@/components/dashboard/widgetTypes';

type AccountingTab = 'overview' | 'chart-of-accounts' | 'journal-entries' | 'fiscal-periods' | 'reports';

const TABS: { id: AccountingTab; label: string; icon: React.ElementType }[] = [
  { id: 'overview',          label: 'Overview',          icon: Calculator     },
  { id: 'chart-of-accounts', label: 'Chart of Accounts', icon: BookOpen       },
  { id: 'journal-entries',   label: 'Journal Entries',   icon: FileSpreadsheet },
  { id: 'fiscal-periods',    label: 'Fiscal Periods',    icon: Calendar       },
  { id: 'reports',           label: 'Reports',            icon: BarChart3      },
];

interface KpiResponse {
  data?: {
    kpis?: {
      revenue?:      { total?: number };
      receivables?:  { total?: number };
      cash?:         { total?: number };
    };
  };
}

export default function AccountingPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { activeCompany, companies, loading: companiesLoading } = useCompany();
  const [activeTab, setActiveTab] = useState<AccountingTab>('overview');
  const [isMounted, setIsMounted] = useState(false);
  const [widgetLayout, setWidgetLayout] = useState<WidgetConfig[]>(DEFAULT_WIDGET_LAYOUT);
  const [widgetEditMode, setWidgetEditMode] = useState(false);
  const [heroStats, setHeroStats] = useState<DashboardHeroStats | undefined>();

  useEffect(() => { setIsMounted(true); }, []);

  // Impersonation: exchange the ?impersonate=<token> query param for company info,
  // inject it into localStorage so CompanyContext picks it up, then reload cleanly.
  useEffect(() => {
    if (!isMounted || !router.isReady) return;
    const impersonateToken = router.query.impersonate as string | undefined;
    if (!impersonateToken) return;

    apiFetch(`/api/auth/impersonate-exchange?token=${encodeURIComponent(impersonateToken)}`)
      .then(async res => {
        const json = await res.json() as { data?: { company_id: string; company_name: string } };
        if (!res.ok || !json.data) throw new Error('Exchange failed');
        const { company_id, company_name } = json.data;
        localStorage.setItem('isaflow_active_company', JSON.stringify({ id: company_id, name: company_name }));
        void router.replace('/accounting', undefined, { shallow: false });
      })
      .catch(err => {
        log.error('Impersonation exchange failed', { error: err }, 'accounting-page');
        void router.replace('/accounting', undefined, { shallow: false });
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMounted, router.isReady, router.query.impersonate]);

  // Redirect users with no companies to onboarding
  useEffect(() => {
    if (!isMounted || authLoading || companiesLoading) return;
    if (!user) return;
    if (router.query.impersonate) return;
    if (companies.length === 0) {
      void router.replace('/onboarding');
    }
  }, [isMounted, authLoading, companiesLoading, user, companies.length, router]);

  // Sync tab from URL query param
  useEffect(() => {
    if (!isMounted) return;
    const tab = router.query.tab as AccountingTab;
    if (tab && TABS.some(t => t.id === tab)) setActiveTab(tab);
  }, [router.query.tab, isMounted]);

  const handleTabChange = useCallback((tab: AccountingTab) => {
    setActiveTab(tab);
    router.push({ pathname: '/accounting', query: { tab } }, undefined, { shallow: true });
  }, [router]);

  // Load widget layout
  useEffect(() => {
    if (!isMounted) return;
    apiFetch('/api/accounting/widget-layout')
      .then(res => res.json())
      .then((json: { data?: { layout?: WidgetConfig[] } }) => {
        const layout = json.data?.layout;
        if (Array.isArray(layout) && layout.length > 0) setWidgetLayout(layout);
      })
      .catch(err => log.error('Failed to load widget layout', { error: err }, 'accounting-page'));
  }, [isMounted]);

  // Load hero KPI stats
  useEffect(() => {
    if (!isMounted) return;
    apiFetch('/api/accounting/kpi-dashboard')
      .then(res => res.json())
      .then((json: KpiResponse) => {
        const kpis = json.data?.kpis;
        if (!kpis) return;
        setHeroStats({
          revenueMtd:           kpis.revenue?.total      ?? 0,
          outstandingInvoices:  kpis.receivables?.total  ?? 0,
          cashPosition:         kpis.cash?.total         ?? 0,
        });
      })
      .catch(err => log.error('Failed to load hero stats', { error: err }, 'accounting-page'));
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
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Premium Hero Header */}
        <div data-tour="dashboard">
          <DashboardHero
            companyName={activeCompany?.tradingName ?? activeCompany?.name ?? 'ISAFlow'}
            stats={heroStats}
          />
        </div>

        {/* Tab bar + actions — dark to match hero */}
        <div className="border-b border-white/10 bg-slate-900/95 backdrop-blur-sm">
          <div className="px-6 flex items-center justify-between">
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
                        ? 'border-teal-500 text-teal-400'
                        : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600'
                      }
                    `}
                  >
                    <Icon className="h-4 w-4" />
                    {tab.label}
                  </button>
                );
              })}
            </nav>
            <div className="flex items-center gap-2 py-2">
              {activeTab === 'overview' && (
                <button
                  onClick={() => setWidgetEditMode(m => !m)}
                  className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                    widgetEditMode
                      ? 'bg-teal-600 text-white border-teal-600 hover:bg-teal-700'
                      : 'border-white/10 text-slate-400 hover:text-slate-200 hover:bg-white/5'
                  }`}
                >
                  <Settings2 className="h-4 w-4" />
                  {widgetEditMode ? 'Done' : 'Edit Widgets'}
                </button>
              )}
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

        {/* Tab Content */}
        <div className="p-6">
          {activeTab === 'overview' && (
            <div className="space-y-6">
              <WidgetGrid
                widgets={widgetLayout}
                editMode={widgetEditMode}
                onLayoutChange={handleLayoutChange}
              />
              <OverviewTab />
            </div>
          )}
          {activeTab === 'chart-of-accounts' && <ChartOfAccountsTab />}
          {activeTab === 'journal-entries'   && <JournalEntriesTab />}
          {activeTab === 'fiscal-periods'    && <FiscalPeriodsTab />}
          {activeTab === 'reports'           && <ReportsTab />}
        </div>
      </div>
    </AppLayout>
  );
}
