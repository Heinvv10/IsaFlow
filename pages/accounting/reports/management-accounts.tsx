/**
 * Management Accounts Report Page
 * One-click combined P&L, Balance Sheet, and Cash Flow for a selected period.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { DataQualityNotice } from '@/components/accounting/DataQualityNotice';
import Link from 'next/link';
import {
  ArrowLeft, BarChart3, Loader2, AlertCircle, ChevronDown, ChevronRight,
  Download, Mail, TrendingUp, Scale, Banknote, DollarSign,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Kpis {
  revenue: number;
  grossProfit: number;
  grossProfitPct: number;
  netProfit: number;
  netProfitPct: number;
  cashPosition: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
}

interface CashFlow {
  operatingCashFlow: number;
  investingCashFlow: number;
  financingCashFlow: number;
  netCashFlow: number;
  openingCash: number;
  closingCash: number;
}

interface ManagementReport {
  companyName: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  kpis: Kpis;
  incomeStatement: Record<string, unknown> & {
    subtypeDisclosure?: {
      grossProfitOverstatedByAtLeast: number;
      costOfSalesExposureAtMost: number;
      otherIncomeExposureAtMost: number;
      accounts: Array<{ reason: string }>;
    } | null;
  };
  balanceSheet: Record<string, unknown>;
  cashFlow: CashFlow;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDefaultDates() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    periodStart: start.toISOString().split('T')[0] ?? '',
    periodEnd: now.toISOString().split('T')[0] ?? '',
  };
}

function fmtPct(n: number) {
  return `${n.toFixed(1)}%`;
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, icon: Icon, color }: {
  label: string; value: string; sub?: string;
  icon: React.ElementType; color: string;
}) {
  return (
    <div className={`rounded-lg border border-${color}-500/20 bg-${color}-500/5 p-4`}>
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`h-4 w-4 text-${color}-400`} />
        <span className="text-xs text-[var(--ff-text-tertiary)]">{label}</span>
      </div>
      <div className={`text-xl font-bold text-${color}-400`}>{value}</div>
      {sub && <div className="text-xs text-[var(--ff-text-tertiary)] mt-1">{sub}</div>}
    </div>
  );
}

// ─── Collapsible section ─────────────────────────────────────────────────────

function Section({ title, icon: Icon, color, defaultOpen, children }: {
  title: string; icon: React.ElementType; color: string;
  defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <div className="border border-[var(--ff-border-light)] rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-[var(--ff-bg-tertiary)] hover:bg-[var(--ff-bg-secondary)] text-left"
      >
        <div className="flex items-center gap-2">
          <Icon className={`h-4 w-4 text-${color}-400`} />
          <span className="text-sm font-medium text-[var(--ff-text-primary)]">{title}</span>
        </div>
        {open
          ? <ChevronDown className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
          : <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)]" />}
      </button>
      {open && <div className="p-4">{children}</div>}
    </div>
  );
}

// ─── Simple KV row ───────────────────────────────────────────────────────────

function KVRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between py-1 text-sm border-b border-[var(--ff-border-light)] last:border-0 ${bold ? 'font-semibold' : ''}`}>
      <span className="text-[var(--ff-text-secondary)]">{label}</span>
      <span className="text-[var(--ff-text-primary)]">{value}</span>
    </div>
  );
}

// ─── Email modal ─────────────────────────────────────────────────────────────

function EmailModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSend() {
    if (!email) return;
    setSending(true);
    await new Promise(r => setTimeout(r, 800)); // placeholder — integrate with email API
    setSent(true);
    setSending(false);
    setTimeout(onClose, 1500);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl p-6 w-full max-w-sm shadow-xl">
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Email Report to Director</h2>
        {sent ? (
          <p className="text-teal-400 text-sm">Report sent successfully.</p>
        ) : (
          <>
            <input
              type="email"
              placeholder="director@company.co.za"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-3 py-2 text-sm text-[var(--ff-text-primary)] mb-4 focus:outline-none focus:border-teal-500"
            />
            <div className="flex gap-2 justify-end">
              <button onClick={onClose} className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
                Cancel
              </button>
              <button
                onClick={handleSend}
                disabled={sending || !email}
                className="px-4 py-2 text-sm bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50"
              >
                {sending ? 'Sending...' : 'Send'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ManagementAccountsPage() {
  const defaults = getDefaultDates();
  const [periodStart, setPeriodStart] = useState(defaults.periodStart);
  const [periodEnd, setPeriodEnd] = useState(defaults.periodEnd);
  const [report, setReport] = useState<ManagementReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showEmail, setShowEmail] = useState(false);

  const loadReport = useCallback(async () => {
    if (!periodStart || !periodEnd) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ period_start: periodStart, period_end: periodEnd });
      const res = await apiFetch(`/api/accounting/reports-management-accounts?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to load');
      setReport(json.data ?? json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, [periodStart, periodEnd]);

  useEffect(() => { void loadReport(); }, [loadReport]);

  function handleDownload() {
    window.print();
  }

  const cf = report?.cashFlow;
  const k = report?.kpis;
  const is = report?.incomeStatement as Record<string, number> | undefined;
  const bs = report?.balanceSheet as Record<string, number> | undefined;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <Link href="/accounting/reports" className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]">
                  <ArrowLeft className="h-5 w-5" />
                </Link>
                <div className="p-2 rounded-lg bg-teal-500/10">
                  <BarChart3 className="h-6 w-6 text-teal-500" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Management Accounts</h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">P&L · Balance Sheet · Cash Flow</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleDownload}
                  className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)]"
                >
                  <Download className="h-4 w-4" /> Download PDF
                </button>
                <button
                  onClick={() => setShowEmail(true)}
                  className="inline-flex items-center gap-2 px-3 py-2 text-sm bg-teal-600 text-white rounded-lg hover:bg-teal-700"
                >
                  <Mail className="h-4 w-4" /> Email to Director
                </button>
              </div>
            </div>
            {/* Period selector */}
            <div className="flex items-center gap-3 mt-4 flex-wrap">
              <div className="flex items-center gap-2">
                <label className="text-xs text-[var(--ff-text-tertiary)]">From</label>
                <input
                  type="date" value={periodStart}
                  onChange={e => setPeriodStart(e.target.value)}
                  className="rounded border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-2 py-1 text-sm text-[var(--ff-text-primary)] focus:outline-none focus:border-teal-500"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-[var(--ff-text-tertiary)]">To</label>
                <input
                  type="date" value={periodEnd}
                  onChange={e => setPeriodEnd(e.target.value)}
                  className="rounded border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-2 py-1 text-sm text-[var(--ff-text-primary)] focus:outline-none focus:border-teal-500"
                />
              </div>
              <button
                onClick={loadReport}
                disabled={loading}
                className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50"
              >
                {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Run
              </button>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-6 max-w-5xl mx-auto space-y-6">
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" /> {error}
            </div>
          )}

          {loading && !report && (
            <div className="flex items-center justify-center py-20 text-[var(--ff-text-tertiary)]">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          )}

          {report && (
            <>
              {/* KPI Summary Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <KpiCard label="Revenue" value={formatCurrency(k?.revenue ?? 0)} icon={DollarSign} color="teal" />
                <KpiCard label="Gross Profit" value={formatCurrency(k?.grossProfit ?? 0)} sub={fmtPct(k?.grossProfitPct ?? 0)} icon={TrendingUp} color="blue" />
                <KpiCard label="Net Profit" value={formatCurrency(k?.netProfit ?? 0)} sub={fmtPct(k?.netProfitPct ?? 0)} icon={BarChart3} color="purple" />
                <KpiCard label="Cash Position" value={formatCurrency(k?.cashPosition ?? 0)} icon={Banknote} color="amber" />
              </div>

              {/* The Gross Profit KPI above comes from the same getIncomeStatement
                  call as the income statement page, and carries the same
                  unclassified-subtype defect. This pack is a document people
                  send onward, so the caveat has to travel with the number. */}
              {report.incomeStatement?.subtypeDisclosure && (
                <DataQualityNotice
                  otherIncomeInTurnover={
                    report.incomeStatement.subtypeDisclosure.grossProfitOverstatedByAtLeast > 0
                      ? {
                          accounts: report.incomeStatement.subtypeDisclosure.accounts.filter(
                            a => a.reason === 'other_income_in_turnover').length,
                          amount: report.incomeStatement.subtypeDisclosure.grossProfitOverstatedByAtLeast,
                        }
                      : null
                  }
                  grossProfitOverstatedByAtLeast={report.incomeStatement.subtypeDisclosure.grossProfitOverstatedByAtLeast}
                  costOfSalesExposureAtMost={report.incomeStatement.subtypeDisclosure.costOfSalesExposureAtMost}
                  otherIncomeExposureAtMost={report.incomeStatement.subtypeDisclosure.otherIncomeExposureAtMost}
                />
              )}

              {/* P&L Section */}
              <Section title="Income Statement (P&L)" icon={TrendingUp} color="teal" defaultOpen>
                <KVRow label="Total Revenue" value={formatCurrency(is?.totalRevenue ?? 0)} bold />
                <KVRow label="Cost of Sales" value={formatCurrency(is?.totalCostOfSales ?? 0)} />
                <KVRow label="Gross Profit" value={formatCurrency(is?.grossProfit ?? 0)} bold />
                <KVRow label="Operating Expenses" value={formatCurrency(is?.totalOperatingExpenses ?? 0)} />
                <KVRow label="Net Profit" value={formatCurrency(is?.netProfit ?? 0)} bold />
              </Section>

              {/* Balance Sheet Section */}
              <Section title="Balance Sheet" icon={Scale} color="blue" defaultOpen>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div>
                    <h4 className="text-xs font-semibold text-[var(--ff-text-tertiary)] uppercase mb-2">Assets</h4>
                    <KVRow label="Total Assets" value={formatCurrency(bs?.totalAssets ?? 0)} bold />
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold text-[var(--ff-text-tertiary)] uppercase mb-2">Liabilities</h4>
                    <KVRow label="Total Liabilities" value={formatCurrency(bs?.totalLiabilities ?? 0)} bold />
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold text-[var(--ff-text-tertiary)] uppercase mb-2">Equity</h4>
                    <KVRow label="Total Equity" value={formatCurrency(bs?.totalEquity ?? 0)} bold />
                  </div>
                </div>
              </Section>

              {/* Cash Flow Section */}
              <Section title="Cash Flow" icon={Banknote} color="amber" defaultOpen>
                <KVRow label="Opening Cash" value={formatCurrency(cf?.openingCash ?? 0)} />
                <KVRow label="Operating Activities" value={formatCurrency(cf?.operatingCashFlow ?? 0)} />
                <KVRow label="Investing Activities" value={formatCurrency(cf?.investingCashFlow ?? 0)} />
                <KVRow label="Financing Activities" value={formatCurrency(cf?.financingCashFlow ?? 0)} />
                <KVRow label="Net Cash Flow" value={formatCurrency(cf?.netCashFlow ?? 0)} bold />
                <KVRow label="Closing Cash" value={formatCurrency(cf?.closingCash ?? 0)} bold />
              </Section>

              <p className="text-xs text-[var(--ff-text-tertiary)] text-right">
                Generated {new Date(report.generatedAt).toLocaleString('en-ZA')}
              </p>
            </>
          )}
        </div>
      </div>

      {showEmail && <EmailModal onClose={() => setShowEmail(false)} />}
    </AppLayout>
  );
}
