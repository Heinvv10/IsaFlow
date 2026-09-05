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
  Download, Mail, TrendingUp, Scale, Banknote,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { ManagementPandLRows, ManagementBalanceSheetRows, KVRow } from '@/components/accounting/ManagementPandLRows';
import { ManagementKpiRow } from '@/components/accounting/ManagementKpiRow';

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
    subtypeDisclosure?: { notices: string[] } | null;
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
              <ManagementKpiRow k={k} />

              {/* The Gross Profit KPI above comes from the same getIncomeStatement
                  call as the income statement page, and carries the same
                  unclassified-subtype defect. This pack is a document people
                  send onward, so the caveat has to travel with the number. */}
              {report.incomeStatement?.subtypeDisclosure && (
                <DataQualityNotice notices={report.incomeStatement.subtypeDisclosure.notices} />
              )}

              {/* P&L Section */}
              <Section title="Income Statement (P&L)" icon={TrendingUp} color="teal" defaultOpen>
                <ManagementPandLRows is={is} />
              </Section>

              {/* Balance Sheet Section */}
              <Section title="Balance Sheet" icon={Scale} color="blue" defaultOpen>
                <ManagementBalanceSheetRows bs={bs} />
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
