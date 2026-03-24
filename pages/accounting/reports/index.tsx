/**
 * Reports Hub — Centralised report navigation
 * Phase 3: Sage-aligned report centre
 */

import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  BarChart3, PieChart, Banknote, Scale, DollarSign,
  Users, ShoppingCart, Landmark, BookOpen, Shield,
  Clock, Receipt,
} from 'lucide-react';

interface ReportCard {
  title: string;
  description: string;
  href: string;
  icon: React.ElementType;
  color: string;
  category: string;
}

const reports: ReportCard[] = [
  // Financial Statements
  { title: 'Income Statement', description: 'Revenue, expenses, and net profit/loss', href: '/accounting/reports/income-statement', icon: BarChart3, color: 'emerald', category: 'Financial Statements' },
  { title: 'Balance Sheet', description: 'Assets, liabilities, and equity snapshot', href: '/accounting/reports/balance-sheet', icon: PieChart, color: 'blue', category: 'Financial Statements' },
  { title: 'Cash Flow', description: 'Operating, investing, and financing activities', href: '/accounting/reports/cash-flow', icon: Banknote, color: 'cyan', category: 'Financial Statements' },
  { title: 'Trial Balance', description: 'All account balances for verification', href: '/accounting/trial-balance', icon: Scale, color: 'purple', category: 'Financial Statements' },
  // Tax & Budget
  { title: 'VAT Return', description: 'Input/output VAT summary for SARS filing', href: '/accounting/reports/vat-return', icon: DollarSign, color: 'red', category: 'Tax & Budget' },
  { title: 'Budget vs Actual', description: 'Budget tracking with variance analysis', href: '/accounting/reports/budget-vs-actual', icon: BarChart3, color: 'amber', category: 'Tax & Budget' },
  // Transaction Reports
  { title: 'Customer Report', description: 'Sales by customer with balances', href: '/accounting/reports/customer-reports', icon: Users, color: 'blue', category: 'Transaction Reports' },
  { title: 'Supplier Report', description: 'Purchases by supplier with balances', href: '/accounting/reports/supplier-reports', icon: ShoppingCart, color: 'orange', category: 'Transaction Reports' },
  { title: 'Bank Transactions', description: 'Bank account activity with running balance', href: '/accounting/reports/bank-transactions', icon: Landmark, color: 'cyan', category: 'Transaction Reports' },
  { title: 'Account Transactions', description: 'GL account drill-down with running balance', href: '/accounting/reports/account-transactions', icon: BookOpen, color: 'violet', category: 'Transaction Reports' },
  { title: 'Aged Receivables', description: 'Customer aging 30/60/90/120+ days', href: '/accounting/ar-aging', icon: Clock, color: 'rose', category: 'Transaction Reports' },
  { title: 'Aged Payables', description: 'Supplier aging 30/60/90/120+ days', href: '/accounting/ap-aging', icon: Receipt, color: 'pink', category: 'Transaction Reports' },
  // Analysis
  { title: 'Project Profitability', description: 'Revenue and costs by project', href: '/accounting/reports/project-profitability', icon: BarChart3, color: 'teal', category: 'Analysis' },
  { title: 'Audit Trail', description: 'Full journal entry audit log', href: '/accounting/reports/audit-trail', icon: Shield, color: 'amber', category: 'Analysis' },
];

const categories = [...new Set(reports.map(r => r.category))];

export default function ReportsHubPage() {
  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10">
              <BarChart3 className="h-6 w-6 text-emerald-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Reports</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Financial statements, transaction reports, and analysis</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-5xl space-y-8">
          {categories.map(cat => (
            <div key={cat}>
              <h2 className="text-sm font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider mb-3">{cat}</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {reports.filter(r => r.category === cat).map(r => (
                  <Link key={r.href} href={r.href}
                    className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4 hover:border-[var(--ff-border-hover)] transition-colors group"
                  >
                    <div className="flex items-start gap-3">
                      <div className={`p-2 rounded-lg bg-${r.color}-500/10 group-hover:bg-${r.color}-500/20 transition-colors`}>
                        <r.icon className={`h-5 w-5 text-${r.color}-500`} />
                      </div>
                      <div>
                        <h3 className="font-medium text-[var(--ff-text-primary)] group-hover:text-white transition-colors">{r.title}</h3>
                        <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">{r.description}</p>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppLayout>
  );
}
