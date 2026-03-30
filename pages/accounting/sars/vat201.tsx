/**
 * VAT201 Form Page
 * Period selector, auto-populated VAT201 fields with invoice breakdown,
 * save draft and mark submitted actions, CSV export.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  FileText, Loader2, Save, Send, Download,
  ChevronLeft, ChevronDown, ChevronRight, Calendar,
} from 'lucide-react';
import { formatDate } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface VAT201Invoice {
  id: string;
  invoiceNumber: string;
  counterpartyName: string;
  invoiceDate: string;
  totalExclVat: number;
  vatAmount: number;
  vatType: string;
}

interface VAT201Data {
  periodStart: string;
  periodEnd: string;
  field1_standardRatedSupplies: number;
  field2_zeroRatedSupplies: number;
  field3_exemptSupplies: number;
  field4_totalImports: number;
  field5_outputVAT: number;
  field6_capitalGoods: number;
  field7_otherGoods: number;
  field8_services: number;
  field9_imports: number;
  field10_totalInputVAT: number;
  field11_vatPayableOrRefundable: number;
  outputInvoices: VAT201Invoice[];
  inputInvoices: VAT201Invoice[];
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface VATQuickPeriod {
  label: string;
  from: string;
  to: string;
}

function pad2(n: number) { return String(n).padStart(2, '0'); }

function buildVatPeriods(year: number, alignment: 'odd' | 'even'): VATQuickPeriod[] {
  const startMonths = alignment === 'even' ? [2, 4, 6, 8, 10, 12] : [1, 3, 5, 7, 9, 11];
  return startMonths.map(sm => {
    const endMonth = sm + 1;
    const endYear = endMonth > 12 ? year + 1 : year;
    const em = endMonth > 12 ? 1 : endMonth;
    const lastDay = new Date(endYear, em, 0).getDate();
    return {
      label: `${MONTH_NAMES[sm - 1]}–${MONTH_NAMES[em - 1]} ${endYear !== year ? year + '/' + endYear : year}`,
      from: `${year}-${pad2(sm)}-01`,
      to: `${endYear}-${pad2(em)}-${pad2(lastDay)}`,
    };
  });
}

function getDefaultPeriod(alignment: 'odd' | 'even' = 'odd'): { from: string; to: string } {
  const now = new Date();
  const year = now.getFullYear();
  const periods = buildVatPeriods(year, alignment);
  const today = now.toISOString().split('T')[0]!;
  const current = periods.find(p => p.from <= today && p.to >= today);
  return current || periods[0]!;
}

export default function VAT201Page() {
  const [alignment, setAlignment] = useState<'odd' | 'even'>('odd');
  const [vatPeriod, setVatPeriod] = useState<'monthly' | 'bi-monthly'>('bi-monthly');
  const [quickPeriods, setQuickPeriods] = useState<VATQuickPeriod[]>([]);
  const defaults = getDefaultPeriod(alignment);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [data, setData] = useState<VAT201Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showOutput, setShowOutput] = useState(false);
  const [showInput, setShowInput] = useState(false);
  const [sarsRef, setSarsRef] = useState('');
  const [savedId, setSavedId] = useState('');
  const [showSubmitModal, setShowSubmitModal] = useState(false);

  // Load company alignment setting
  useEffect(() => {
    (async () => {
      const res = await apiFetch('/api/accounting/companies', { credentials: 'include' });
      const json = await res.json();
      if (res.ok && json.data) {
        const c = Array.isArray(json.data) ? json.data[0] : json.data;
        const a = c?.vatPeriodAlignment || c?.vat_period_alignment || 'odd';
        const vp = c?.vatPeriod || c?.vat_period || 'bi-monthly';
        setAlignment(a);
        setVatPeriod(vp);
        const year = new Date().getFullYear();
        if (vp === 'monthly') {
          const months: VATQuickPeriod[] = [];
          for (let m = 1; m <= 12; m++) {
            const lastDay = new Date(year, m, 0).getDate();
            months.push({
              label: `${MONTH_NAMES[m - 1]} ${year}`,
              from: `${year}-${pad2(m)}-01`,
              to: `${year}-${pad2(m)}-${pad2(lastDay)}`,
            });
          }
          setQuickPeriods(months);
        } else {
          setQuickPeriods(buildVatPeriods(year, a));
        }
        const def = getDefaultPeriod(a);
        setFrom(def.from);
        setTo(def.to);
      }
    })();
  }, []);

  const generate = useCallback(async () => {
    if (!from || !to) return;
    setLoading(true);
    setError('');
    setSuccess('');
    setData(null);
    setSavedId('');
    try {
      const res = await apiFetch(
        `/api/accounting/sars/sars-vat201?from=${from}&to=${to}`,
        { credentials: 'include' }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.message || 'Failed');
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate VAT201');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  const saveDraft = async () => {
    if (!data) return;
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/sars/sars-vat201', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ periodStart: from, periodEnd: to }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.message || 'Failed');
      setSavedId(json.data?.id || '');
      setSuccess('VAT201 draft saved successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save draft');
    } finally {
      setSaving(false);
    }
  };

  const markSubmitted = async () => {
    if (!savedId || !sarsRef.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/sars/sars-submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id: savedId, action: 'mark_submitted', reference: sarsRef.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.message || 'Failed');
      setSuccess('VAT201 marked as submitted to SARS');
      setShowSubmitModal(false);
      setSarsRef('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark as submitted');
    } finally {
      setSubmitting(false);
    }
  };

  const exportCSV = () => {
    if (!data) return;
    const rows = [
      ['Field', 'Description', 'Amount (ZAR)'],
      ['1', 'Standard-rated supplies (15%)', data.field1_standardRatedSupplies.toFixed(2)],
      ['2', 'Zero-rated supplies', data.field2_zeroRatedSupplies.toFixed(2)],
      ['3', 'Exempt supplies', data.field3_exemptSupplies.toFixed(2)],
      ['4', 'Total imports', data.field4_totalImports.toFixed(2)],
      ['5', 'Output VAT (Field 1 x 15%)', data.field5_outputVAT.toFixed(2)],
      ['6', 'Input VAT — Capital goods', data.field6_capitalGoods.toFixed(2)],
      ['7', 'Input VAT — Other goods', data.field7_otherGoods.toFixed(2)],
      ['8', 'Input VAT — Services', data.field8_services.toFixed(2)],
      ['9', 'Input VAT — Imports', data.field9_imports.toFixed(2)],
      ['10', 'Total input VAT', data.field10_totalInputVAT.toFixed(2)],
      ['11', 'VAT payable / (refundable)', data.field11_vatPayableOrRefundable.toFixed(2)],
      [],
      ['Period', `${data.periodStart} to ${data.periodEnd}`],
    ];
    const csv = rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `VAT201_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link
                href="/accounting/sars"
                className="p-2 rounded-lg hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]"
              >
                <ChevronLeft className="h-5 w-5" />
              </Link>
              <div className="p-2 rounded-lg bg-teal-500/10">
                <FileText className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">VAT201 Return</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  SARS Value-Added Tax Declaration
                </p>
              </div>
            </div>
            {data && (
              <div className="flex items-center gap-2">
                <button
                  onClick={exportCSV}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:border-teal-500/30"
                >
                  <Download className="h-4 w-4" /> Export CSV
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="p-6 space-y-6">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}
          {success && <div className="p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm">{success}</div>}

          {/* Period Selector */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-[var(--ff-text-secondary)] flex items-center gap-2">
                <Calendar className="h-4 w-4" /> VAT Period
              </h2>
              <span className="text-xs text-[var(--ff-text-tertiary)]">
                {vatPeriod === 'monthly' ? 'Monthly' : alignment === 'even' ? 'Bi-Monthly (Category B)' : 'Bi-Monthly (Category A)'}
              </span>
            </div>

            {/* Quick Period Buttons */}
            {quickPeriods.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-4">
                {quickPeriods.map(p => (
                  <button
                    key={p.from}
                    onClick={() => { setFrom(p.from); setTo(p.to); }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      from === p.from && to === p.to
                        ? 'bg-teal-600 text-white border-teal-600'
                        : 'border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:border-teal-500/50 hover:text-[var(--ff-text-primary)]'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Period Start</label>
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="px-3 py-2 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Period End</label>
                <input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="px-3 py-2 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm"
                />
              </div>
              <button
                onClick={generate}
                disabled={loading}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-teal-600 text-white text-sm font-medium hover:bg-teal-700 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                Generate
              </button>
            </div>
          </div>

          {/* VAT201 Form */}
          {data && (
            <>
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
                <div className="px-4 py-3 border-b border-[var(--ff-border-light)]">
                  <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
                    VAT201 — {formatDate(data.periodStart)} to {formatDate(data.periodEnd)}
                  </h2>
                </div>

                <div className="divide-y divide-[var(--ff-border-light)]">
                  {/* Output Section */}
                  <div className="px-4 py-2 bg-teal-500/5">
                    <p className="text-xs font-semibold text-teal-500 uppercase tracking-wider">Output VAT (Sales)</p>
                  </div>
                  <FormRow field="1" label="Standard-rated supplies (15%)" amount={data.field1_standardRatedSupplies} />
                  <FormRow field="2" label="Zero-rated supplies" amount={data.field2_zeroRatedSupplies} />
                  <FormRow field="3" label="Exempt supplies" amount={data.field3_exemptSupplies} />
                  <FormRow field="4" label="Total imports" amount={data.field4_totalImports} />
                  <FormRow field="5" label="Output VAT (Field 1 x 15%)" amount={data.field5_outputVAT} highlight />

                  {/* Input Section */}
                  <div className="px-4 py-2 bg-blue-500/5">
                    <p className="text-xs font-semibold text-blue-500 uppercase tracking-wider">Input VAT (Purchases)</p>
                  </div>
                  <FormRow field="6" label="Capital goods" amount={data.field6_capitalGoods} />
                  <FormRow field="7" label="Other goods" amount={data.field7_otherGoods} />
                  <FormRow field="8" label="Services" amount={data.field8_services} />
                  <FormRow field="9" label="Imports" amount={data.field9_imports} />
                  <FormRow field="10" label="Total input VAT" amount={data.field10_totalInputVAT} highlight />

                  {/* Result */}
                  <div className="px-4 py-2 bg-[var(--ff-bg-primary)]">
                    <p className="text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">Result</p>
                  </div>
                  <div className="px-4 py-3 flex items-center justify-between bg-[var(--ff-bg-primary)]/50">
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-mono text-[var(--ff-text-tertiary)] w-8">11</span>
                      <span className="text-sm font-semibold text-[var(--ff-text-primary)]">
                        {data.field11_vatPayableOrRefundable >= 0 ? 'VAT Payable to SARS' : 'VAT Refundable from SARS'}
                      </span>
                    </div>
                    <span className={`text-lg font-bold ${
                      data.field11_vatPayableOrRefundable >= 0 ? 'text-red-400' : 'text-emerald-400'
                    }`}>
                      {fmt(Math.abs(data.field11_vatPayableOrRefundable))}
                    </span>
                  </div>
                </div>
              </div>

              {/* Invoice Breakdowns */}
              <InvoiceBreakdown
                title="Output Invoices (Sales)"
                invoices={data.outputInvoices}
                open={showOutput}
                onToggle={() => setShowOutput(!showOutput)}
              />
              <InvoiceBreakdown
                title="Input Invoices (Purchases)"
                invoices={data.inputInvoices}
                open={showInput}
                onToggle={() => setShowInput(!showInput)}
              />

              {/* Actions */}
              <div className="flex items-center gap-3">
                <button
                  onClick={saveDraft}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-teal-600 text-white text-sm font-medium hover:bg-teal-700 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save Draft
                </button>
                {savedId && (
                  <button
                    onClick={() => setShowSubmitModal(true)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700"
                  >
                    <Send className="h-4 w-4" /> Mark as Submitted
                  </button>
                )}
              </div>
            </>
          )}

          {/* Submit Modal */}
          {showSubmitModal && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 w-full max-w-md mx-4">
                <h3 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">
                  Mark as Submitted to SARS
                </h3>
                <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
                  Enter the SARS eFiling reference number after submitting the return on the SARS eFiling portal.
                </p>
                <input
                  type="text"
                  value={sarsRef}
                  onChange={(e) => setSarsRef(e.target.value)}
                  placeholder="SARS reference number"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm mb-4"
                />
                <div className="flex items-center gap-3 justify-end">
                  <button
                    onClick={() => setShowSubmitModal(false)}
                    className="px-4 py-2 rounded-lg text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={markSubmitted}
                    disabled={submitting || !sarsRef.trim()}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    Confirm
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

function FormRow({
  field,
  label,
  amount,
  highlight,
}: {
  field: string;
  label: string;
  amount: number;
  highlight?: boolean;
}) {
  return (
    <div className={`px-4 py-3 flex items-center justify-between ${highlight ? 'bg-[var(--ff-bg-primary)]/30' : ''}`}>
      <div className="flex items-center gap-3">
        <span className="text-sm font-mono text-[var(--ff-text-tertiary)] w-8">{field}</span>
        <span className={`text-sm ${highlight ? 'font-semibold text-[var(--ff-text-primary)]' : 'text-[var(--ff-text-secondary)]'}`}>
          {label}
        </span>
      </div>
      <span className={`text-sm font-medium ${highlight ? 'text-[var(--ff-text-primary)]' : 'text-[var(--ff-text-secondary)]'}`}>
        {fmt(amount)}
      </span>
    </div>
  );
}

function InvoiceBreakdown({
  title,
  invoices,
  open,
  onToggle,
}: {
  title: string;
  invoices: VAT201Invoice[];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
      <button
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-[var(--ff-bg-primary)]/30"
      >
        <span className="text-sm font-medium text-[var(--ff-text-primary)]">
          {title} ({invoices.length})
        </span>
        {open ? <ChevronDown className="h-4 w-4 text-[var(--ff-text-tertiary)]" /> : <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)]" />}
      </button>
      {open && (
        <div className="border-t border-[var(--ff-border-light)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                <th className="px-4 py-2">Invoice</th>
                <th className="px-4 py-2">Counterparty</th>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">VAT Type</th>
                <th className="px-4 py-2 text-right">Excl. VAT</th>
                <th className="px-4 py-2 text-right">VAT</th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-4 text-center text-[var(--ff-text-tertiary)]">
                    No invoices for this period.
                  </td>
                </tr>
              )}
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                  <td className="px-4 py-2 text-[var(--ff-text-primary)] font-medium">{inv.invoiceNumber}</td>
                  <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{inv.counterpartyName}</td>
                  <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{formatDate(inv.invoiceDate)}</td>
                  <td className="px-4 py-2">
                    <span className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-teal-500/10 text-teal-400">
                      {inv.vatType}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right text-[var(--ff-text-primary)]">{fmt(inv.totalExclVat)}</td>
                  <td className="px-4 py-2 text-right text-teal-400 font-medium">{fmt(inv.vatAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
