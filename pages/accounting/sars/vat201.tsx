/**
 * VAT201 Form Page — thin shell
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { FileText, Loader2, Save, Send, Download, ChevronLeft } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { VAT201PeriodSelector } from '@/components/accounting/sars/VAT201PeriodSelector';
import { TransactionTable } from '@/components/accounting/sars/VAT201FormSections';
import { VAT201SummaryForm } from '@/components/accounting/sars/VAT201SummaryForm';
import { VAT201SubmitModal } from '@/components/accounting/sars/VAT201SubmitModal';

interface VAT201Invoice {
  id: string; invoiceNumber: string; counterpartyName: string;
  invoiceDate: string; totalExclVat: number; vatAmount: number; vatType: string;
}

interface VAT201Data {
  periodStart: string; periodEnd: string;
  field1_standardRatedSupplies: number; field2_zeroRatedSupplies: number;
  field3_exemptSupplies: number; field4_totalImports: number; field5_outputVAT: number;
  field6_capitalGoods: number; field7_otherGoods: number; field8_services: number;
  field9_imports: number; field10_totalInputVAT: number; field11_vatPayableOrRefundable: number;
  outputInvoices: VAT201Invoice[]; inputInvoices: VAT201Invoice[];
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
interface VATQuickPeriod { label: string; from: string; to: string }

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
      from: `${year}-${pad2(sm)}-01`, to: `${endYear}-${pad2(em)}-${pad2(lastDay)}`,
    };
  });
}

function getDefaultPeriod(alignment: 'odd' | 'even' = 'odd'): { from: string; to: string } {
  const now = new Date();
  const year = now.getFullYear();
  const periods = buildVatPeriods(year, alignment);
  const today = now.toISOString().split('T')[0]!;
  return periods.find(p => p.from <= today && p.to >= today) || periods[0]!;
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
  const [viewMode, setViewMode] = useState<'summary' | 'detail'>('summary');
  const [sarsRef, setSarsRef] = useState('');
  const [savedId, setSavedId] = useState('');
  const [showSubmitModal, setShowSubmitModal] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await apiFetch('/api/accounting/companies', { credentials: 'include' });
      const json = await res.json();
      if (res.ok && json.data) {
        const c = Array.isArray(json.data) ? json.data[0] : json.data;
        const a = c?.vatPeriodAlignment || c?.vat_period_alignment || 'odd';
        const vp = c?.vatPeriod || c?.vat_period || 'bi-monthly';
        setAlignment(a); setVatPeriod(vp);
        const year = new Date().getFullYear();
        if (vp === 'monthly') {
          const months: VATQuickPeriod[] = [];
          for (let m = 1; m <= 12; m++) {
            const lastDay = new Date(year, m, 0).getDate();
            months.push({ label: `${MONTH_NAMES[m - 1]} ${year}`, from: `${year}-${pad2(m)}-01`, to: `${year}-${pad2(m)}-${pad2(lastDay)}` });
          }
          setQuickPeriods(months);
        } else {
          setQuickPeriods(buildVatPeriods(year, a));
        }
        const def = getDefaultPeriod(a);
        setFrom(def.from); setTo(def.to);
      }
    })();
  }, []);

  const generate = useCallback(async () => {
    if (!from || !to) return;
    setLoading(true); setError(''); setSuccess(''); setData(null); setSavedId('');
    try {
      const res = await apiFetch(`/api/accounting/sars/sars-vat201?from=${from}&to=${to}`, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.message || 'Failed');
      setData(json.data);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to generate VAT201'); }
    finally { setLoading(false); }
  }, [from, to]);

  const saveDraft = async () => {
    if (!data) return;
    setSaving(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/sars/sars-vat201', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ periodStart: from, periodEnd: to }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.message || 'Failed');
      setSavedId(json.data?.id || '');
      setSuccess('VAT201 draft saved successfully');
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to save draft'); }
    finally { setSaving(false); }
  };

  const markSubmitted = async () => {
    if (!savedId || !sarsRef.trim()) return;
    setSubmitting(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/sars/sars-submissions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ id: savedId, action: 'mark_submitted', reference: sarsRef.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.message || 'Failed');
      setSuccess('VAT201 marked as submitted to SARS');
      setShowSubmitModal(false); setSarsRef('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to mark as submitted'); }
    finally { setSubmitting(false); }
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
      [], ['Period', `${data.periodStart} to ${data.periodEnd}`],
    ];
    const csv = rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `VAT201_${from}_${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/accounting/sars" className="p-2 rounded-lg hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]">
                <ChevronLeft className="h-5 w-5" />
              </Link>
              <div className="p-2 rounded-lg bg-teal-500/10"><FileText className="h-6 w-6 text-teal-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">VAT201 Return</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">SARS Value-Added Tax Declaration</p>
              </div>
            </div>
            {data && (
              <button onClick={exportCSV} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:border-teal-500/30">
                <Download className="h-4 w-4" /> Export CSV
              </button>
            )}
          </div>
        </div>

        <div className="p-6 space-y-6">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}
          {success && <div className="p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm">{success}</div>}

          <VAT201PeriodSelector
            from={from} to={to} loading={loading} vatPeriod={vatPeriod} alignment={alignment}
            quickPeriods={quickPeriods}
            onFromChange={setFrom} onToChange={setTo}
            onQuickSelect={(f, t) => { setFrom(f); setTo(t); }}
            onGenerate={generate}
          />

          {data && (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1 bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-1">
                  {(['summary', 'detail'] as const).map(mode => (
                    <button key={mode} onClick={() => setViewMode(mode)}
                      className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${viewMode === mode ? 'bg-teal-600 text-white' : 'text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}>
                      {mode.charAt(0).toUpperCase() + mode.slice(1)}
                    </button>
                  ))}
                </div>
                <span className="text-xs text-[var(--ff-text-tertiary)]">
                  {viewMode === 'summary' ? 'SARS VAT201 box totals' : `${data.outputInvoices.length + data.inputInvoices.length} transactions`}
                </span>
              </div>

              {viewMode === 'summary' ? (
                <VAT201SummaryForm data={data} />
              ) : (
                <div className="space-y-4">
                  <TransactionTable title="Section A — Output Tax (Sales)" sectionColor="teal" invoices={data.outputInvoices} totalLabel="Total Output Tax (Box 13)" totalVat={data.field5_outputVAT} />
                  <TransactionTable title="Section B — Input Tax (Purchases)" sectionColor="blue" invoices={data.inputInvoices} totalLabel="Total Input Tax (Box 19)" totalVat={data.field10_totalInputVAT} />
                  <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] px-4 py-3 flex items-center justify-between">
                    <span className="text-sm font-semibold text-[var(--ff-text-primary)]">
                      Net VAT — Box 20 ({data.field11_vatPayableOrRefundable >= 0 ? 'Payable to SARS' : 'Refundable from SARS'})
                    </span>
                    <span className={`text-lg font-bold ${data.field11_vatPayableOrRefundable >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                      {fmt(Math.abs(data.field11_vatPayableOrRefundable))}
                    </span>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3">
                <button onClick={saveDraft} disabled={saving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-teal-600 text-white text-sm font-medium hover:bg-teal-700 disabled:opacity-50">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Draft
                </button>
                {savedId && (
                  <button onClick={() => setShowSubmitModal(true)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700">
                    <Send className="h-4 w-4" /> Mark as Submitted
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {showSubmitModal && (
        <VAT201SubmitModal
          sarsRef={sarsRef} submitting={submitting}
          onRefChange={setSarsRef}
          onConfirm={() => void markSubmitted()}
          onClose={() => setShowSubmitModal(false)}
        />
      )}
    </AppLayout>
  );
}
