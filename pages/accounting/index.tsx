/**
 * Accounting Module — thin shell with tab routing
 * Tab content lives in src/components/accounting/dashboard/
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import Link from 'next/link';
import {
  Calculator, BookOpen, FileSpreadsheet, Calendar, BarChart3, Plus, Loader2,
} from 'lucide-react';
import { OverviewTab } from '@/components/accounting/dashboard/OverviewTab';
import { ChartOfAccountsTab } from '@/components/accounting/dashboard/ChartOfAccountsTab';
import { JournalEntriesTab } from '@/components/accounting/dashboard/JournalEntriesTab';
import { FiscalPeriodsTab } from '@/components/accounting/dashboard/FiscalPeriodsTab';
import { ReportsTab } from '@/components/accounting/dashboard/ReportsTab';
import { type WidgetConfig, DEFAULT_WIDGET_LAYOUT } from '@/components/dashboard/widgetTypes';

type AccountingTab = 'overview' | 'chart-of-accounts' | 'journal-entries' | 'fiscal-periods' | 'reports';

const TABS: { id: AccountingTab; label: string; icon: React.ElementType }[] = [
  { id: 'overview',          label: 'Overview',          icon: Calculator     },
  { id: 'chart-of-accounts', label: 'Chart of Accounts', icon: BookOpen       },
  { id: 'journal-entries',   label: 'Journal Entries',   icon: FileSpreadsheet },
  { id: 'fiscal-periods',    label: 'Fiscal Periods',    icon: Calendar       },
  { id: 'reports',           label: 'Reports',            icon: BarChart3      },
];

export default function AccountingPage() {
  const router = useRouter();
  const { activeCompany } = useCompany();
  const [activeTab, setActiveTab] = useState<AccountingTab>('overview');
  const [isMounted, setIsMounted] = useState(false);
  const [widgetLayout, setWidgetLayout] = useState<WidgetConfig[]>(DEFAULT_WIDGET_LAYOUT);

  useEffect(() => { setIsMounted(true); }, []);

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

  // Load and persist widget layout
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

  const handleLayoutChange = useCallback((layout: WidgetConfig[]) => {
    setWidgetLayout(layout);
    apiFetch('/api/accounting/widget-layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout }),
    }).catch(err => log.error('Failed to save widget layout', { error: err }, 'accounting-page'));
  }, []);

  // Suppress unused-var lint — layout callbacks kept for future widget editing
  void widgetLayout;
  void handleLayoutChange;

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
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                    {activeCompany?.tradingName || activeCompany?.name || 'ISAFlow'}
                  </h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">
                    General Ledger, Journal Entries &amp; Financial Reports
                  </p>
                </div>
              </div>
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
          {activeTab === 'overview'          && <OverviewTab />}
          {activeTab === 'chart-of-accounts' && <ChartOfAccountsTab />}
          {activeTab === 'journal-entries'   && <JournalEntriesTab />}
          {activeTab === 'fiscal-periods'    && <FiscalPeriodsTab />}
          {activeTab === 'reports'           && <ReportsTab />}
        </div>
      </div>
    </AppLayout>
  );
}
