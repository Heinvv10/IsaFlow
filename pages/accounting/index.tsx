/**
 * Accounting Module — thin shell with tab routing.
 * Tabs are integrated into DashboardHero as a pill bar.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { Skeleton } from '@/components/ui/Skeleton';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useCompany } from '@/contexts/CompanyContext';
import { ApiEnvelopeError, apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import {
  Calculator, BookOpen, FileSpreadsheet, Calendar, BarChart3,
} from 'lucide-react';
import { OverviewTab, type KPIData, type KpiLoad } from '@/components/accounting/dashboard/OverviewTab';
import { ChartOfAccountsTab } from '@/components/accounting/dashboard/ChartOfAccountsTab';
import { JournalEntriesTab } from '@/components/accounting/dashboard/JournalEntriesTab';
import { FiscalPeriodsTab } from '@/components/accounting/dashboard/FiscalPeriodsTab';
import { ReportsTab } from '@/components/accounting/dashboard/ReportsTab';
import { DashboardHero, type DashboardHeroStats, type HeroTab } from '@/components/accounting/dashboard/DashboardHero';
import { ModuleSetupChecklist } from '@/components/accounting/dashboard/ModuleSetupChecklist';
import { useSetupProgress, isSetupOpen, isSetupUnknown } from '@/components/accounting/dashboard/useSetupProgress';

type AccountingTab = 'overview' | 'chart-of-accounts' | 'journal-entries' | 'fiscal-periods' | 'reports';

const TABS: HeroTab[] = [
  { id: 'overview',          label: 'Overview',          icon: Calculator      },
  { id: 'chart-of-accounts', label: 'Chart of Accounts', icon: BookOpen        },
  { id: 'journal-entries',   label: 'Journal Entries',   icon: FileSpreadsheet },
  { id: 'fiscal-periods',    label: 'Fiscal Periods',    icon: Calendar        },
  { id: 'reports',           label: 'Reports',           icon: BarChart3       },
];

export default function AccountingPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { activeCompany, companies, loading: companiesLoading } = useCompany();
  const [activeTab, setActiveTab] = useState<AccountingTab>('overview');
  const [isMounted, setIsMounted] = useState(false);
  // One kpi-dashboard load feeds the hero and the Overview tab.
  const [kpiLoad, setKpiLoad] = useState<KpiLoad>({ data: null, error: '', loading: true });
  const [impersonateError, setImpersonateError] = useState('');
  const setup = useSetupProgress(activeCompany?.id);

  useEffect(() => { setIsMounted(true); }, []);

  // Impersonation exchange
  useEffect(() => {
    if (!isMounted || !router.isReady) return;
    const impersonateToken = router.query.impersonate as string | undefined;
    if (!impersonateToken) return;

    apiFetch(`/api/auth/impersonate-exchange?token=${encodeURIComponent(impersonateToken)}`)
      .then(async res => {
        await assertOk(res, 'Could not switch to that company - try again');
        const json = await res.json() as { data?: { company_id: string; company_name: string } };
        if (!json.data) throw new ApiEnvelopeError('Could not switch to that company - try again');
        const { company_id, company_name } = json.data;
        localStorage.setItem('isaflow_active_company', JSON.stringify({ id: company_id, name: company_name }));
        // Hard navigation (not router.replace): the exchange rotated the
        // active_company cookie, and CompanyContext hydrates once per mount —
        // a soft replace leaves the header on the OLD company while data
        // panels already show the new one (W7 residual).
        window.location.assign('/accounting');
      })
      .catch(err => {
        log.error('Impersonation exchange failed', { error: err }, 'accounting-page');
        setImpersonateError(apiErrorMessage(err, 'Could not switch to that company - try again'));
        void router.replace('/accounting', undefined, { shallow: false });
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMounted, router.isReady, router.query.impersonate]);

  // Redirect users with no companies to onboarding (super_admin exempt)
  useEffect(() => {
    if (!isMounted || authLoading || companiesLoading) return;
    if (!user || user.role === 'super_admin') return;
    if (router.query.impersonate) return;
    if (companies.length === 0) void router.replace('/onboarding');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMounted, authLoading, companiesLoading, user?.id, user?.role, companies.length]);

  // Sync tab from URL
  useEffect(() => {
    if (!isMounted) return;
    const tab = router.query.tab as AccountingTab;
    if (tab && TABS.some(t => t.id === tab)) setActiveTab(tab);
  }, [router.query.tab, isMounted]);

  const handleTabChange = useCallback((tab: string) => {
    // chart-of-accounts and fiscal-periods have dedicated standalone pages —
    // navigate there so deep links / bookmarks / emails resolve correctly.
    if (tab === 'chart-of-accounts') {
      void router.push('/accounting/chart-of-accounts');
      return;
    }
    if (tab === 'fiscal-periods') {
      void router.push('/accounting/fiscal-periods');
      return;
    }
    setActiveTab(tab as AccountingTab);
    void router.push({ pathname: '/accounting', query: { tab } }, undefined, { shallow: true });
  }, [router]);

  // Load the dashboard figures once, for the hero and the Overview tab.
  // `cancelled` drops an answer that lands after the company changed (or the
  // page left): the old company's figures must not replace the new one's.
  useEffect(() => {
    if (!isMounted) return;
    let cancelled = false;
    setKpiLoad({ data: null, error: '', loading: true });
    apiFetch('/api/accounting/kpi-dashboard')
      .then(async res => { await assertOk(res, 'Could not load the dashboard figures - try again'); return res.json(); })
      .then((json: { data?: KPIData }) => { if (!cancelled) setKpiLoad({ data: json.data ?? null, error: '', loading: false }); })
      .catch(err => {
        log.error('Failed to load dashboard figures', { error: err }, 'accounting-page');
        if (!cancelled) setKpiLoad({ data: null, error: apiErrorMessage(err, 'Could not load the dashboard figures - try again'), loading: false });
      });
    return () => { cancelled = true; };
  }, [isMounted, activeCompany?.id]);

  const kpis = kpiLoad.data?.kpis;
  const heroStats: DashboardHeroStats | undefined = kpis && {
    revenueMtd:          kpis.revenueMtd         ?? 0,
    outstandingInvoices: kpis.receivables?.total ?? 0,
    cashPosition:        kpis.cash?.total        ?? 0,
  };
  const heroError = kpiLoad.error;

  // The skeleton holds until the setup checklist is known: it renders ABOVE the
  // hero, so arriving later would push the whole page down (CLS).
  // With no company at all (nothing will ever be asked) there is nothing to wait for.
  const setupPending = setup.loading && (companiesLoading || !!activeCompany?.id);
  if (!isMounted || setupPending) {
    return (
      <AppLayout>
        {/* Distinct keys: React must not reuse the skeleton's nodes for the content, or each reused node "moves" (CLS). */}
        <div key="dashboard-skeleton" className="min-h-screen bg-surface p-6 space-y-6">
          <div role="status" aria-busy="true" aria-label="Loading accounting module" data-testid="dashboard-skeleton" className="space-y-6">
            <Skeleton variant="heading" width="25%" />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
              <Skeleton variant="card" count={4} />
            </div>
            <Skeleton variant="card" height="16rem" />
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div key="dashboard-content" className="min-h-screen bg-[image:var(--ff-canvas-gradient)]">

        {/* Hero card with integrated pill tabs */}
        <div data-tour="dashboard" className="px-6 pt-6">
          {activeTab === 'overview' && setup.progress && !setup.progress.allComplete && (
            <div className="mb-5"><ModuleSetupChecklist progress={setup.progress} /></div>
          )}
          <DashboardHero
            companyName={activeCompany?.tradingName ?? activeCompany?.name ?? 'ISAFlow'}
            loading={companiesLoading}
            stats={heroStats}
            tabs={TABS}
            activeTab={activeTab}
            onTabChange={handleTabChange}
          />
          {impersonateError && <p role="alert" className="mt-2 text-sm text-red-500">{impersonateError}</p>}
          {heroError && <p role="alert" className="mt-2 text-sm text-red-500">{heroError}</p>}
        </div>

        {/* key={activeCompany?.id} forces full remount when company switches,
            so each tab's useEffect re-fires with the correct localStorage company */}
        <div className="p-6 pt-5" key={activeCompany?.id ?? 'loading'}>
          {activeTab === 'overview'          && <OverviewTab setupOpen={isSetupOpen(setup)} setupUnknown={isSetupUnknown(setup)} kpiLoad={kpiLoad} />}
          {activeTab === 'chart-of-accounts' && <ChartOfAccountsTab />}
          {activeTab === 'journal-entries'   && <JournalEntriesTab />}
          {activeTab === 'fiscal-periods'    && <FiscalPeriodsTab />}
          {activeTab === 'reports'           && <ReportsTab />}
        </div>
      </div>
    </AppLayout>
  );
}
