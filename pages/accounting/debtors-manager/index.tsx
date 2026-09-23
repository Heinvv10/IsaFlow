/**
 * Debtors Manager Page
 * Sage-parity collections / aging dashboard
 * Paths: /accounting/debtors-manager
 */

import { Fragment, useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, AlertCircle, Users, TrendingDown, Clock, Percent, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type {
  DebtorSummary,
  CollectionStats,
  OverdueInvoice,
} from '@/modules/accounting/services/ar/debtorsManagerService';
import { DebtorInvoicesPanel } from '@/components/accounting/DebtorInvoicesPanel';
import { buildInvoiceHref } from '@/components/accounting/invoiceReturnContext';
import { useAgingReturn, agingRowId } from '@/components/accounting/useAgingReturn';
import { INVOICE_LINK } from '@/components/accounting/agingPanelFormat';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(amount: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-ZA');
}

// ── Stat Card ─────────────────────────────────────────────────────────────────

interface StatCardProps { label: string; value: string; sub?: string; icon: React.ElementType; color: string }
function StatCard({ label, value, sub, icon: Icon, color }: StatCardProps) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
      <div className="flex items-center gap-2 mb-2">
        <div className={`p-1.5 rounded ${color}/10`}><Icon className={`h-4 w-4 ${color}`} /></div>
        <p className="text-xs text-[var(--ff-text-secondary)] uppercase">{label}</p>
      </div>
      <p className={`text-xl font-bold font-mono ${color}`}>{value}</p>
      {sub && <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">{sub}</p>}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function DebtorsManagerPage() {
  const [summary, setSummary] = useState<DebtorSummary[]>([]);
  const [stats, setStats] = useState<CollectionStats | null>(null);
  const [overdueInvoices, setOverdueInvoices] = useState<OverdueInvoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const { expandedId, toggle: toggleExpand } = useAgingReturn({
    entityParam: 'customer', rowsReady: !isLoading && summary.length > 0,
  });

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/debtors-manager');
      const json = await res.json();
      const payload = json.data ?? json;
      setSummary(Array.isArray(payload.summary) ? payload.summary : []);
      setStats(payload.stats ?? null);
      setOverdueInvoices(Array.isArray(payload.overdueInvoices) ? payload.overdueInvoices : []);
    } catch {
      setError('Failed to load debtors data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  const filtered = summary.filter(d =>
    d.clientName.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">

        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-red-500/10">
              <Users className="h-6 w-6 text-red-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Debtors Manager</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Collections aging dashboard — outstanding customer invoices</p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {/* Stats Cards */}
          {stats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="Total Outstanding" value={fmt(stats.totalOutstanding)} sub={`${stats.clientCount} customers`} icon={TrendingDown} color="text-[var(--ff-text-primary)]" />
              <StatCard label="Total Overdue" value={fmt(stats.totalOverdue)} sub={`${stats.overdueCount} invoices`} icon={AlertCircle} color="text-red-500" />
              <StatCard label="Avg Days Overdue" value={`${stats.avgDaysOutstanding}d`} sub="On overdue invoices" icon={Clock} color="text-amber-500" />
              <StatCard label="Collection Rate" value={`${stats.collectionRate}%`} sub="Paid vs invoiced" icon={Percent} color="text-teal-500" />
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 rounded-lg text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />{error}
            </div>
          )}

          {/* Aging Summary Table */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--ff-border-light)]">
              <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Aging by Customer</h2>
              <div className="flex items-center gap-2">
                <Search className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                <input
                  type="text"
                  placeholder="Search customer..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="ff-input text-sm w-48"
                />
              </div>
            </div>

            {isLoading ? (
              <div className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" /></div>
            ) : filtered.length === 0 ? (
              <div className="p-8 text-center text-[var(--ff-text-secondary)] text-sm">No outstanding debtor balances</div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                    <th className="px-4 py-3 text-left text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase w-6"></th>
                    <th className="px-4 py-3 text-left text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Customer</th>
                    <th className="px-4 py-3 text-right text-[10px] tracking-[0.12em] font-semibold text-teal-500 uppercase">Current</th>
                    <th className="px-4 py-3 text-right text-[10px] tracking-[0.12em] font-semibold text-amber-500 uppercase">1–30 Days</th>
                    <th className="px-4 py-3 text-right text-[10px] tracking-[0.12em] font-semibold text-orange-500 uppercase">31–60 Days</th>
                    <th className="px-4 py-3 text-right text-[10px] tracking-[0.12em] font-semibold text-red-400 uppercase">61–90 Days</th>
                    <th className="px-4 py-3 text-right text-[10px] tracking-[0.12em] font-semibold text-red-600 uppercase">90+ Days</th>
                    <th className="px-4 py-3 text-right text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {filtered.map(d => (
                    <Fragment key={d.clientId}>
                      <tr
                        id={agingRowId(d.clientId)}
                        className="hover:bg-teal-500/[0.04] transition-colors cursor-pointer"
                        onClick={() => toggleExpand(d.clientId)}
                      >
                        <td className="px-4 py-3 text-[var(--ff-text-tertiary)]">
                          {expandedId === d.clientId
                            ? <ChevronDown className="h-4 w-4" />
                            : <ChevronRight className="h-4 w-4" />}
                        </td>
                        <td className="px-4 py-3 text-sm font-medium text-[var(--ff-text-primary)]">
                          <Link href={`/accounting/customers/${d.clientId}`} onClick={e => e.stopPropagation()} className="hover:text-teal-400 hover:underline">
                            {d.clientName}
                          </Link>
                          <span className="ml-2 text-xs text-[var(--ff-text-tertiary)]">({d.invoiceCount} inv.)</span>
                        </td>
                        <td className="px-4 py-3 text-sm text-right font-mono text-teal-500">{d.current > 0 ? fmt(d.current) : '—'}</td>
                        <td className="px-4 py-3 text-sm text-right font-mono text-amber-500">{d.days30 > 0 ? fmt(d.days30) : '—'}</td>
                        <td className="px-4 py-3 text-sm text-right font-mono text-orange-500">{d.days60 > 0 ? fmt(d.days60) : '—'}</td>
                        <td className="px-4 py-3 text-sm text-right font-mono text-red-400">{d.days90 > 0 ? fmt(d.days90) : '—'}</td>
                        <td className="px-4 py-3 text-sm text-right font-mono text-red-600">{d.days90Plus > 0 ? fmt(d.days90Plus) : '—'}</td>
                        <td className="px-4 py-3 text-sm text-right font-mono font-bold text-[var(--ff-text-primary)]">{fmt(d.totalOutstanding)}</td>
                      </tr>
                      {expandedId === d.clientId && (
                        <DebtorInvoicesPanel clientId={d.clientId} clientName={d.clientName} from="debtors" colSpan={8} />
                      )}
                    </Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-[var(--ff-border-medium)] bg-[var(--ff-bg-tertiary)]">
                    <td className="px-4 py-3"></td>
                    <td className="px-4 py-3 text-sm font-bold text-[var(--ff-text-primary)]">TOTAL</td>
                    <td className="px-4 py-3 text-sm text-right font-mono font-bold text-teal-500">{fmt(filtered.reduce((s, d) => s + d.current, 0))}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono font-bold text-amber-500">{fmt(filtered.reduce((s, d) => s + d.days30, 0))}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono font-bold text-orange-500">{fmt(filtered.reduce((s, d) => s + d.days60, 0))}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono font-bold text-red-400">{fmt(filtered.reduce((s, d) => s + d.days90, 0))}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono font-bold text-red-600">{fmt(filtered.reduce((s, d) => s + d.days90Plus, 0))}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono font-bold text-[var(--ff-text-primary)]">{fmt(filtered.reduce((s, d) => s + d.totalOutstanding, 0))}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>

          {/* Top Overdue Invoices — quick reference */}
          {overdueInvoices.length > 0 && !isLoading && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <div className="px-4 py-3 border-b border-[var(--ff-border-light)]">
                <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">
                  Most Overdue Invoices <span className="text-[var(--ff-text-tertiary)] font-normal">({overdueInvoices.length} total)</span>
                </h2>
              </div>
              <table className="w-full">
                <thead>
                  <tr className="bg-[var(--ff-bg-tertiary)] border-b border-[var(--ff-border-light)]">
                    <th className="px-4 py-2 text-left text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Invoice #</th>
                    <th className="px-4 py-2 text-left text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Customer</th>
                    <th className="px-4 py-2 text-left text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Due Date</th>
                    <th className="px-4 py-2 text-right text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Days Overdue</th>
                    <th className="px-4 py-2 text-right text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Outstanding</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {overdueInvoices.slice(0, 10).map(inv => (
                    <tr key={inv.id} className="hover:bg-teal-500/[0.04]">
                      <td className="px-4 py-2 text-sm font-mono">
                        <Link href={buildInvoiceHref(inv.id, { from: 'debtors', entityId: inv.clientId })} className={INVOICE_LINK}>
                          {inv.invoiceNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">{inv.clientName}</td>
                      <td className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">{fmtDate(inv.dueDate)}</td>
                      <td className="px-4 py-2 text-sm text-right font-mono tabular-nums text-red-400">{inv.daysOverdue}d</td>
                      <td className="px-4 py-2 text-sm text-right font-mono tabular-nums font-bold text-red-500">{fmt(inv.outstanding)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
