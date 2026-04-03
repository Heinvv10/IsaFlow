/**
 * Reports Hub — Centralised report navigation
 * Phase 3: Sage-aligned report centre
 * WS-G1: Favouriting + show-descriptions toggle
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  BarChart3, PieChart, Banknote, Scale, DollarSign,
  Users, ShoppingCart, Landmark, BookOpen,
  Clock, Receipt, TrendingUp, Layers, Activity,
  LayoutDashboard, FolderOpen, GitBranch, Star, AlignJustify,
} from 'lucide-react';
import { FavouriteButton } from '@/components/accounting/reports/FavouriteButton';
import { useReportFavourites } from '@/hooks/useReportFavourites';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { cn } from '@/utils/cn';

// ─── Report data ──────────────────────────────────────────────────────────────

interface ReportCard {
  id: string;
  title: string;
  description?: string;
  href: string;
  icon: React.ElementType;
  color: string;
  category: string;
}

const REPORT_DESCRIPTIONS: Record<string, string> = {
  'income-statement': 'Revenue and expenses for a selected period',
  'balance-sheet': 'Assets, liabilities, and equity at a point in time',
  'cash-flow': 'Cash movements from operating, investing, and financing activities',
  'trial-balance': 'All account balances in debit and credit columns',
  'vat-return': 'VAT201 return calculation for SARS submission',
  'budget-vs-actual': 'Compare budgeted vs actual figures with variance analysis',
  'customer-reports': 'Sales by customer with outstanding balances',
  'supplier-reports': 'Purchases by supplier with outstanding balances',
  'bank-transactions': 'Bank account activity with running balance',
  'account-transactions': 'GL account drill-down with running balance',
  'ar-aging': 'Outstanding customer invoices by age bucket (30/60/90/120+ days)',
  'ap-aging': 'Outstanding supplier invoices by age bucket (30/60/90/120+ days)',
  'project-profitability': 'Revenue and costs tracked by project',
  'audit-trail': 'Full journal entry audit log with user attribution',
  'financial-analysis': 'Deep-dive financial ratios and performance metrics',
  'waterfall': 'Visual breakdown of cumulative financial changes',
  'trend-analysis': 'Month-on-month and year-on-year trend tracking',
  'executive-dashboard': 'High-level KPIs and summary metrics for leadership',
  'report-packs': 'Bundled report sets for board and stakeholder distribution',
  'three-way-forecast': 'Integrated P&L, balance sheet, and cash flow projections',
};

const reports: ReportCard[] = [
  { id: 'income-statement',    title: 'Income Statement',     description: REPORT_DESCRIPTIONS['income-statement'],     href: '/accounting/reports/income-statement',      icon: BarChart3,       color: 'teal',   category: 'Financial Statements' },
  { id: 'balance-sheet',       title: 'Balance Sheet',        description: REPORT_DESCRIPTIONS['balance-sheet'],        href: '/accounting/reports/balance-sheet',          icon: PieChart,        color: 'blue',   category: 'Financial Statements' },
  { id: 'cash-flow',           title: 'Cash Flow',            description: REPORT_DESCRIPTIONS['cash-flow'],            href: '/accounting/reports/cash-flow',              icon: Banknote,        color: 'cyan',   category: 'Financial Statements' },
  { id: 'trial-balance',       title: 'Trial Balance',        description: REPORT_DESCRIPTIONS['trial-balance'],        href: '/accounting/trial-balance',                  icon: Scale,           color: 'purple', category: 'Financial Statements' },
  { id: 'vat-return',          title: 'VAT Return',           description: REPORT_DESCRIPTIONS['vat-return'],           href: '/accounting/reports/vat-return',             icon: DollarSign,      color: 'red',    category: 'Tax & Budget' },
  { id: 'budget-vs-actual',    title: 'Budget vs Actual',     description: REPORT_DESCRIPTIONS['budget-vs-actual'],     href: '/accounting/reports/budget-vs-actual',       icon: BarChart3,       color: 'amber',  category: 'Tax & Budget' },
  { id: 'customer-reports',    title: 'Customer Report',      description: REPORT_DESCRIPTIONS['customer-reports'],     href: '/accounting/reports/customer-reports',       icon: Users,           color: 'blue',   category: 'Transaction Reports' },
  { id: 'supplier-reports',    title: 'Supplier Report',      description: REPORT_DESCRIPTIONS['supplier-reports'],     href: '/accounting/reports/supplier-reports',       icon: ShoppingCart,    color: 'orange', category: 'Transaction Reports' },
  { id: 'bank-transactions',   title: 'Bank Transactions',    description: REPORT_DESCRIPTIONS['bank-transactions'],    href: '/accounting/reports/bank-transactions',      icon: Landmark,        color: 'cyan',   category: 'Transaction Reports' },
  { id: 'account-transactions', title: 'Account Transactions', description: REPORT_DESCRIPTIONS['account-transactions'], href: '/accounting/reports/account-transactions',  icon: BookOpen,        color: 'violet', category: 'Transaction Reports' },
  { id: 'ar-aging',            title: 'Aged Receivables',     description: REPORT_DESCRIPTIONS['ar-aging'],             href: '/accounting/ar-aging',                       icon: Clock,           color: 'rose',   category: 'Transaction Reports' },
  { id: 'ap-aging',            title: 'Aged Payables',        description: REPORT_DESCRIPTIONS['ap-aging'],             href: '/accounting/ap-aging',                       icon: Receipt,         color: 'pink',   category: 'Transaction Reports' },
  { id: 'project-profitability', title: 'Project Profitability', description: REPORT_DESCRIPTIONS['project-profitability'], href: '/accounting/reports/project-profitability', icon: BarChart3,     color: 'teal',   category: 'Analysis' },
  { id: 'audit-trail',         title: 'Audit Trail',          description: REPORT_DESCRIPTIONS['audit-trail'],          href: '/accounting/reports/audit-trail',            icon: BarChart3,       color: 'amber',  category: 'Analysis' },
  { id: 'financial-analysis',  title: 'Financial Analysis',   description: REPORT_DESCRIPTIONS['financial-analysis'],   href: '/accounting/reports/financial-analysis',     icon: TrendingUp,      color: 'indigo', category: 'Analytics' },
  { id: 'waterfall',           title: 'Waterfall Charts',     description: REPORT_DESCRIPTIONS['waterfall'],            href: '/accounting/reports/waterfall',              icon: Layers,          color: 'violet', category: 'Analytics' },
  { id: 'trend-analysis',      title: 'Trend Analysis',       description: REPORT_DESCRIPTIONS['trend-analysis'],       href: '/accounting/reports/trend-analysis',         icon: Activity,        color: 'cyan',   category: 'Analytics' },
  { id: 'executive-dashboard', title: 'Executive Dashboard',  description: REPORT_DESCRIPTIONS['executive-dashboard'],  href: '/accounting/reports/executive-dashboard',    icon: LayoutDashboard, color: 'blue',   category: 'Analytics' },
  { id: 'report-packs',        title: 'Report Packs',         description: REPORT_DESCRIPTIONS['report-packs'],         href: '/accounting/reports/report-packs',           icon: FolderOpen,      color: 'amber',  category: 'Analytics' },
  { id: 'three-way-forecast',  title: 'Three-Way Forecast',   description: REPORT_DESCRIPTIONS['three-way-forecast'],   href: '/accounting/reports/three-way-forecast',     icon: GitBranch,       color: 'teal',   category: 'Analytics' },
];

const reportById = new Map(reports.map(r => [r.id, r]));
const categories = [...new Set(reports.map(r => r.category))];

// Full class strings so Tailwind purge retains them — never use template literals.
const COLOR_CLASSES: Record<string, { bg: string; bgHover: string; text: string }> = {
  teal:   { bg: 'bg-teal-500/10',   bgHover: 'group-hover:bg-teal-500/20',   text: 'text-teal-500' },
  blue:   { bg: 'bg-blue-500/10',   bgHover: 'group-hover:bg-blue-500/20',   text: 'text-blue-500' },
  cyan:   { bg: 'bg-cyan-500/10',   bgHover: 'group-hover:bg-cyan-500/20',   text: 'text-cyan-500' },
  purple: { bg: 'bg-purple-500/10', bgHover: 'group-hover:bg-purple-500/20', text: 'text-purple-500' },
  red:    { bg: 'bg-red-500/10',    bgHover: 'group-hover:bg-red-500/20',    text: 'text-red-500' },
  amber:  { bg: 'bg-amber-500/10',  bgHover: 'group-hover:bg-amber-500/20',  text: 'text-amber-500' },
  orange: { bg: 'bg-orange-500/10', bgHover: 'group-hover:bg-orange-500/20', text: 'text-orange-500' },
  violet: { bg: 'bg-violet-500/10', bgHover: 'group-hover:bg-violet-500/20', text: 'text-violet-500' },
  rose:   { bg: 'bg-rose-500/10',   bgHover: 'group-hover:bg-rose-500/20',   text: 'text-rose-500' },
  pink:   { bg: 'bg-pink-500/10',   bgHover: 'group-hover:bg-pink-500/20',   text: 'text-pink-500' },
  indigo: { bg: 'bg-indigo-500/10', bgHover: 'group-hover:bg-indigo-500/20', text: 'text-indigo-500' },
};

const SHOW_DESC_PREF = 'report_show_descriptions';

// ─── Show-descriptions toggle hook ────────────────────────────────────────────

function useShowDescriptions() {
  const [showDesc, setShowDesc] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void (async () => {
      try {
        const res = await apiFetch('/api/auth/preferences');
        if (!res.ok) return;
        const json = (await res.json()) as { data?: Record<string, string> };
        if (json.data?.[SHOW_DESC_PREF] === 'true') setShowDesc(true);
      } catch (err) {
        log.error('Failed to load show-descriptions pref', { err }, 'ReportsHub');
      }
    })();
  }, []);

  const toggle = useCallback(() => {
    setShowDesc(prev => {
      const next = !prev;
      void apiFetch('/api/auth/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: { [SHOW_DESC_PREF]: String(next) } }),
      }).catch(err => log.error('Failed to save show-descriptions pref', { err }, 'ReportsHub'));
      return next;
    });
  }, []);

  return { showDesc, toggle };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ReportItem({ report, showDesc }: { report: ReportCard; showDesc: boolean }) {
  return (
    <Link
      href={report.href}
      className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4 hover:border-[var(--ff-border-hover)] transition-colors group"
    >
      <div className="flex items-start gap-3">
        <div className={cn('p-2 rounded-lg transition-colors shrink-0', COLOR_CLASSES[report.color]?.bg, COLOR_CLASSES[report.color]?.bgHover)}>
          <report.icon className={cn('h-5 w-5', COLOR_CLASSES[report.color]?.text)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <h3 className="font-medium text-[var(--ff-text-primary)] group-hover:text-white transition-colors truncate">
              {report.title}
            </h3>
            <FavouriteButton reportId={report.id} className="shrink-0" />
          </div>
          {showDesc && (
            <p className="text-xs text-[var(--ff-text-tertiary)] mt-1 leading-relaxed">
              {report.description}
            </p>
          )}
        </div>
      </div>
    </Link>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ReportsHubPage() {
  const { favourites, isFavourite } = useReportFavourites();
  const { showDesc, toggle: toggleDesc } = useShowDescriptions();

  const favouriteReports = favourites
    .map(id => reportById.get(id))
    .filter((r): r is ReportCard => r !== undefined);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Page header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <BarChart3 className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Reports</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Financial statements, transaction reports, and analysis</p>
              </div>
            </div>

            {/* Show descriptions toggle */}
            <button
              type="button"
              onClick={toggleDesc}
              aria-pressed={showDesc}
              className={cn(
                'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                showDesc
                  ? 'border-teal-500/50 bg-teal-500/10 text-teal-400'
                  : 'border-[var(--ff-border-light)] bg-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:border-[var(--ff-border-hover)]',
              )}
            >
              <AlignJustify className="h-4 w-4" />
              Descriptions
            </button>
          </div>
        </div>

        <div className="p-6 max-w-5xl space-y-8">
          {/* Favourites section — only shown when at least 1 favourite */}
          {favouriteReports.length > 0 && (
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider mb-3">
                <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                Favourites
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {favouriteReports.map(r => (
                  <ReportItem key={r.id} report={r} showDesc={showDesc} />
                ))}
              </div>
            </div>
          )}

          {/* All report categories */}
          {categories.map(cat => (
            <div key={cat}>
              <h2 className="text-sm font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider mb-3">
                {cat}
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {reports.filter(r => r.category === cat).map(r => (
                  <ReportItem key={r.id} report={r} showDesc={showDesc} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppLayout>
  );
}
