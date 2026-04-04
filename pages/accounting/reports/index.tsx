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
  BookMarked, UserCheck, Package, Truck, PackageSearch,
  List, ArrowLeftRight, Gem, Inbox, Send,
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
  // Financial Statements
  'income-statement':        'Revenue and expenses for a selected period, with comparative analysis',
  'balance-sheet':           'Assets, liabilities, and equity at a specific point in time',
  'cash-flow':               'Cash movements from operating, investing, and financing activities',
  'trial-balance':           'All ledger account balances presented in debit and credit columns',
  // Tax & Budget
  'vat-return':              'VAT201 return calculation and summary prepared for SARS submission',
  'budget-vs-actual':        'Budgeted figures compared to actuals with variance and percentage analysis',
  // Transaction Reports
  'general-ledger':          'Complete transaction history across all accounts for a selected period',
  'customer-reports':        'Sales totals and outstanding balances summarised by customer',
  'supplier-reports':        'Purchase totals and outstanding balances summarised by supplier',
  'bank-transactions':       'Bank account transactions with a running balance for reconciliation',
  'account-transactions':    'Drill-down transaction history for a selected general ledger account',
  'ar-aging':                'Outstanding customer invoices grouped by 30/60/90/120+ day aging buckets',
  'ap-aging':                'Outstanding supplier invoices grouped by 30/60/90/120+ day aging buckets',
  'unallocated-receipts':    'Customer receipts that have not yet been matched to an invoice',
  'unallocated-payments':    'Supplier payments that have not yet been matched to an invoice',
  // Analysis
  'sales-by-customer':       'Invoice and receipt totals broken down by customer for a selected period',
  'sales-by-item':           'Revenue and quantity sold per inventory item or service line',
  'purchases-by-supplier':   'Purchase invoice totals broken down by supplier for a selected period',
  'purchases-by-item':       'Purchase spend and quantity per inventory item or expense category',
  'project-profitability':   'Revenue and costs tracked per project to show individual project margins',
  // Inventory
  'item-listing':            'Complete list of all inventory items with current cost and selling prices',
  'item-movement':           'Stock movements showing goods received, sold, and adjusted per item',
  'item-valuation':          'Current on-hand inventory value calculated at cost or weighted average',
  // Analytics
  'financial-analysis':      'Financial ratios and performance metrics for deep-dive business analysis',
  'waterfall':               'Visual cumulative breakdown of how revenue builds to net profit',
  'trend-analysis':          'Month-on-month and year-on-year trend tracking across key financial lines',
  'executive-dashboard':     'High-level KPIs and summary metrics formatted for leadership review',
  'report-packs':            'Bundled report sets for board meetings and stakeholder distribution',
  'three-way-forecast':      'Integrated P&L, balance sheet, and cash flow projections',
  // Audit
  'audit-trail':             'Full journal entry log with timestamps and user attribution for compliance',
};

const reports: ReportCard[] = [
  { id: 'income-statement',    title: 'Income Statement',     description: REPORT_DESCRIPTIONS['income-statement'],     href: '/accounting/reports/income-statement',      icon: BarChart3,       color: 'teal',   category: 'Financial Statements' },
  { id: 'balance-sheet',       title: 'Balance Sheet',        description: REPORT_DESCRIPTIONS['balance-sheet'],        href: '/accounting/reports/balance-sheet',          icon: PieChart,        color: 'blue',   category: 'Financial Statements' },
  { id: 'cash-flow',           title: 'Cash Flow',            description: REPORT_DESCRIPTIONS['cash-flow'],            href: '/accounting/reports/cash-flow',              icon: Banknote,        color: 'cyan',   category: 'Financial Statements' },
  { id: 'trial-balance',       title: 'Trial Balance',        description: REPORT_DESCRIPTIONS['trial-balance'],        href: '/accounting/trial-balance',                  icon: Scale,           color: 'purple', category: 'Financial Statements' },
  { id: 'vat-return',          title: 'VAT Return',           description: REPORT_DESCRIPTIONS['vat-return'],           href: '/accounting/reports/vat-return',             icon: DollarSign,      color: 'red',    category: 'Tax & Budget' },
  { id: 'budget-vs-actual',    title: 'Budget vs Actual',     description: REPORT_DESCRIPTIONS['budget-vs-actual'],     href: '/accounting/reports/budget-vs-actual',       icon: BarChart3,       color: 'amber',  category: 'Tax & Budget' },
  { id: 'general-ledger',       title: 'General Ledger',       description: REPORT_DESCRIPTIONS['general-ledger'],       href: '/accounting/reports/general-ledger',         icon: BookMarked,      color: 'violet', category: 'Transaction Reports' },
  { id: 'bank-transactions',   title: 'Bank Transactions',    description: REPORT_DESCRIPTIONS['bank-transactions'],    href: '/accounting/reports/bank-transactions',      icon: Landmark,        color: 'cyan',   category: 'Transaction Reports' },
  { id: 'account-transactions', title: 'Account Transactions', description: REPORT_DESCRIPTIONS['account-transactions'], href: '/accounting/reports/account-transactions',  icon: BookOpen,        color: 'violet', category: 'Transaction Reports' },
  { id: 'ar-aging',            title: 'Aged Receivables',     description: REPORT_DESCRIPTIONS['ar-aging'],             href: '/accounting/ar-aging',                       icon: Clock,           color: 'rose',   category: 'Transaction Reports' },
  { id: 'ap-aging',            title: 'Aged Payables',        description: REPORT_DESCRIPTIONS['ap-aging'],             href: '/accounting/ap-aging',                       icon: Receipt,         color: 'pink',   category: 'Transaction Reports' },
  { id: 'unallocated-receipts', title: 'Unallocated Receipts', description: REPORT_DESCRIPTIONS['unallocated-receipts'], href: '/accounting/reports/unallocated-receipts',  icon: Inbox,           color: 'amber',  category: 'Transaction Reports' },
  { id: 'unallocated-payments', title: 'Unallocated Payments', description: REPORT_DESCRIPTIONS['unallocated-payments'], href: '/accounting/reports/unallocated-payments',  icon: Send,            color: 'orange', category: 'Transaction Reports' },
  { id: 'sales-by-customer',   title: 'Sales by Customer',    description: REPORT_DESCRIPTIONS['sales-by-customer'],    href: '/accounting/reports/sales-by-customer',      icon: UserCheck,       color: 'blue',   category: 'Analysis' },
  { id: 'sales-by-item',       title: 'Sales by Item',        description: REPORT_DESCRIPTIONS['sales-by-item'],        href: '/accounting/reports/sales-by-item',          icon: Package,         color: 'teal',   category: 'Analysis' },
  { id: 'purchases-by-supplier', title: 'Purchases by Supplier', description: REPORT_DESCRIPTIONS['purchases-by-supplier'], href: '/accounting/reports/purchases-by-supplier', icon: Truck,          color: 'orange', category: 'Analysis' },
  { id: 'purchases-by-item',   title: 'Purchases by Item',    description: REPORT_DESCRIPTIONS['purchases-by-item'],    href: '/accounting/reports/purchases-by-item',      icon: PackageSearch,   color: 'amber',  category: 'Analysis' },
  { id: 'customer-reports',    title: 'Customer Report',      description: REPORT_DESCRIPTIONS['customer-reports'],     href: '/accounting/reports/customer-reports',       icon: Users,           color: 'blue',   category: 'Analysis' },
  { id: 'supplier-reports',    title: 'Supplier Report',      description: REPORT_DESCRIPTIONS['supplier-reports'],     href: '/accounting/reports/supplier-reports',       icon: ShoppingCart,    color: 'orange', category: 'Analysis' },
  { id: 'project-profitability', title: 'Project Profitability', description: REPORT_DESCRIPTIONS['project-profitability'], href: '/accounting/reports/project-profitability', icon: BarChart3,     color: 'teal',   category: 'Analysis' },
  { id: 'audit-trail',         title: 'Audit Trail',          description: REPORT_DESCRIPTIONS['audit-trail'],          href: '/accounting/reports/audit-trail',            icon: BarChart3,       color: 'amber',  category: 'Analysis' },
  { id: 'item-listing',        title: 'Item Listing',         description: REPORT_DESCRIPTIONS['item-listing'],         href: '/accounting/reports/item-listing',           icon: List,            color: 'blue',   category: 'Inventory' },
  { id: 'item-movement',       title: 'Item Movement',        description: REPORT_DESCRIPTIONS['item-movement'],        href: '/accounting/reports/item-movement',          icon: ArrowLeftRight,  color: 'cyan',   category: 'Inventory' },
  { id: 'item-valuation',      title: 'Item Valuation',       description: REPORT_DESCRIPTIONS['item-valuation'],       href: '/accounting/reports/item-valuation',         icon: Gem,             color: 'purple', category: 'Inventory' },
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
  const { favourites } = useReportFavourites();
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
