/**
 * VAT201 Form Page — thin shell
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { FileText, Loader2, Save, Send, Download, ChevronLeft, ShieldCheck } from 'lucide-react';
import { ApiRequestError, apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { VAT201PeriodSelector } from '@/components/accounting/sars/VAT201PeriodSelector';
import { TransactionTable } from '@/components/accounting/sars/VAT201FormSections';
import { VAT201SummaryForm } from '@/components/accounting/sars/VAT201SummaryForm';
import { buildVat201Csv } from '@/components/accounting/sars/vat201Csv';
import { VAT201SubmitModal } from '@/components/accounting/sars/VAT201SubmitModal';
import { VAT201ExceptionsPanel } from '@/components/accounting/sars/VAT201ExceptionsPanel';
import { VAT201SarsSubmit } from '@/components/accounting/sars/VAT201SarsSubmit';
import type { VatGateCounts } from '@/components/accounting/sars/VatGateOverrideBox';
import {
  vatQuickPeriods, defaultVatQuickPeriod, normalizeVatAlignment, normalizeVatSetting,
  type VatQuickPeriod,
} from '@/modules/bureau/services/vatPeriodHelper';
import { useCompany } from '@/contexts/CompanyContext';
import { useVatRegistration } from '@/hooks/useVatRegistration';
import { NotVatRegisteredNotice } from '@/components/accounting/NotVatRegisteredNotice';
import type { VatExceptionsReport } from '@/modules/accounting/services/reports/vatExceptionsTypes';
import type { Vat201SarsField } from '@/modules/accounting/services/reports/vat201SarsFields';

interface VAT201Invoice {
  id: string; invoiceNumber: string; counterpartyName: string;
  invoiceDate: string; totalExclVat: number; vatAmount: number; vatType: string;
}

interface VAT201Data { // the API also returns legacy field1..11 storage keys; the page uses only the SARS form
  periodStart: string; periodEnd: string;
  sarsFields: Vat201SarsField[];
  outputInvoices: VAT201Invoice[]; inputInvoices: VAT201Invoice[];
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const OVERRIDE_ROLES = ['owner', 'admin', 'super_admin'];

/** A SARS field's amount, as the server computed it. */
const sarsAmount = (data: VAT201Data, field: string): number =>
  data.sarsFields.find((f) => f.field === field)?.amount ?? 0;

export default function VAT201Page() {
  const { activeCompany, companyRole } = useCompany();
  const isOwnerOrAdmin = OVERRIDE_ROLES.includes(companyRole ?? '');
  const { isRegistered, known } = useVatRegistration();
  const [alignment, setAlignment] = useState<'odd' | 'even'>('odd');
  const [vatPeriod, setVatPeriod] = useState<'monthly' | 'bi-monthly'>('bi-monthly');
  const [quickPeriods, setQuickPeriods] = useState<VatQuickPeriod[]>([]);
  // The selector waits for the company's VAT settings. Shown earlier it printed the
  // bi-monthly default, then flipped its label and grew a row of chips ~90ms later,
  // pushing Generate down 46px: a click at the first position hit a chip, no request.
  const [settingsReady, setSettingsReady] = useState(false);
  const defaults = defaultVatQuickPeriod(vatPeriod, alignment, new Date());
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
  const [submitBlockedCounts, setSubmitBlockedCounts] = useState<VatGateCounts | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [exceptionsKey, setExceptionsKey] = useState(0);
  const [exceptionsReport, setExceptionsReport] = useState<VatExceptionsReport | null>(null);
  const exceptionsReady = exceptionsReport !== null;
  const exceptionsClean = exceptionsReady && exceptionsReport.totalExceptions === 0 && !exceptionsReport.degradedData;

  useEffect(() => {
    // The list endpoint (/api/accounting/companies) returns slim
    // { items: CompanyUser[] } rows WITHOUT VAT settings — reading them put
    // every company on the odd/bi-monthly defaults. Fetch the active
    // company's full record (?id=) instead, same as the settings page.
    if (!activeCompany?.id) return;
    let cancelled = false;
    setSettingsReady(false);
    void (async () => {
      try {
        const res = await apiFetch(`/api/accounting/companies?id=${activeCompany.id}`, { credentials: 'include' });
        await assertOk(res, 'Could not load company VAT settings');
        const json = await res.json();
        if (cancelled || !json.data) return;
        const c = json.data as Record<string, unknown>;
        const a = normalizeVatAlignment((c.vatPeriodAlignment ?? c.vat_period_alignment) as string | undefined);
        const setting = normalizeVatSetting(
          (c.vatPeriod ?? c.vat_period) as string | undefined,
          (c.vatSystemType ?? c.vat_system_type) as string | undefined,
        );
        // Non-vendors render the notice instead; leave the period state alone.
        if (setting === 'none') { setSettingsReady(true); return; }
        const vp = setting;
        setAlignment(a); setVatPeriod(vp);
        setQuickPeriods(vatQuickPeriods(new Date().getFullYear(), vp, a));
        const def = defaultVatQuickPeriod(vp, a, new Date());
        setFrom(def.from); setTo(def.to);
        setSettingsReady(true);
      } catch {
        // Silent defaults are exactly the bug class this effect fixes — say so.
        if (!cancelled) {
          setError('Could not load company VAT settings — periods shown use the bi-monthly Category A default');
          setSettingsReady(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activeCompany?.id]);

  const generate = useCallback(async () => {
    if (!from || !to) return;
    setLoading(true); setError(''); setSuccess(''); setData(null); setSavedId(''); setExceptionsReport(null);
    try {
      const res = await apiFetch(`/api/accounting/sars/sars-vat201?from=${from}&to=${to}`, { credentials: 'include' });
      await assertOk(res, 'Could not generate VAT201 - try again');
      const json = await res.json();
      setData(json.data);
      setExceptionsKey(k => k + 1);
    } catch (err) { setData(null); setError(apiErrorMessage(err, 'Could not generate VAT201 - try again')); }
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
      await assertOk(res, 'Could not save draft - try again');
      const json = await res.json();
      setSavedId(json.data?.id || '');
      setSuccess('VAT201 draft saved successfully');
    } catch (err) { setError(apiErrorMessage(err, 'Could not save draft - try again')); }
    finally { setSaving(false); }
  };

  const markSubmitted = async () => {
    if (!savedId || !sarsRef.trim()) return;
    setSubmitting(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/sars/sars-submissions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          id: savedId, action: 'mark_submitted', reference: sarsRef.trim(),
          ...(overrideReason.trim() ? { overrideReason: overrideReason.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        // The gate refusal carries getVatExceptions' blocking counts
        // (error.details.counts) — show the blocking list, and (owner/admin
        // only) the override box, instead of only a generic error banner.
        const counts = json?.error?.details?.counts as VatGateCounts | undefined;
        if (counts) setSubmitBlockedCounts(counts);
        throw new ApiRequestError(json?.error?.message || json?.message || 'Could not mark the VAT201 as submitted - try again', res.status);
      }
      setSuccess('VAT201 marked as submitted to SARS');
      setShowSubmitModal(false); setSarsRef(''); setSubmitBlockedCounts(null); setOverrideReason('');
    } catch (err) { setError(apiErrorMessage(err, 'Could not mark the VAT201 as submitted - try again')); }
    finally { setSubmitting(false); }
  };

  const exportCSV = () => {
    if (!data) return;
    const csv = buildVat201Csv(data);
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
            <div className="flex items-center gap-2">
              <Link href="/accounting/sars/vat-locks" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:border-teal-500/30">
                <ShieldCheck className="h-4 w-4" /> Period Locks
              </Link>
              {data && (
                <button onClick={exportCSV} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:border-teal-500/30">
                  <Download className="h-4 w-4" /> Export CSV
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}
          {success && <div className="p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm">{success}</div>}

          {known && !isRegistered && <NotVatRegisteredNotice surface="The VAT201 return" />}

          {known && isRegistered && !settingsReady && (
            <div data-testid="vat201-period-loading" aria-busy="true"
              className="h-[8.5rem] rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] flex items-center justify-center text-sm text-[var(--ff-text-tertiary)]">
              <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading VAT period settings
            </div>
          )}

          {known && isRegistered && settingsReady && <VAT201PeriodSelector
            from={from} to={to} loading={loading} vatPeriod={vatPeriod} alignment={alignment}
            quickPeriods={quickPeriods}
            onFromChange={setFrom} onToChange={setTo}
            onQuickSelect={(f, t) => { setFrom(f); setTo(t); }}
            onGenerate={generate}
          />}

          {known && isRegistered && data && (
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
                  <TransactionTable title="Section A — Output Tax (Sales)" sectionColor="teal" invoices={data.outputInvoices} totalLabel="Total Output Tax (Field 13)" totalVat={sarsAmount(data, '13')} />
                  <TransactionTable title="Section B — Input Tax (Purchases)" sectionColor="blue" invoices={data.inputInvoices} totalLabel="Total Input Tax (Field 19)" totalVat={sarsAmount(data, '19')} />
                  <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] px-4 py-3 flex items-center justify-between">
                    <span className="text-sm font-semibold text-[var(--ff-text-primary)]">
                      Net VAT — Field 20 ({sarsAmount(data, '20') >= 0 ? 'Payable to SARS' : 'Refundable from SARS'})
                    </span>
                    <span className={`text-lg font-bold ${sarsAmount(data, '20') >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                      {fmt(Math.abs(sarsAmount(data, '20')))}
                    </span>
                  </div>
                </div>
              )}

              <VAT201ExceptionsPanel from={data.periodStart} to={data.periodEnd} reloadKey={exceptionsKey} onLoaded={setExceptionsReport} />

              <div className="flex items-center gap-3">
                <button onClick={saveDraft} disabled={saving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-teal-600 text-white text-sm font-medium hover:bg-teal-700 disabled:opacity-50">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Draft
                </button>
                {savedId && (
                  <button onClick={() => { setSubmitBlockedCounts(null); setOverrideReason(''); setShowSubmitModal(true); }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
                    <Send className="h-4 w-4" /> Mark as Submitted (manual)
                  </button>
                )}
              </div>

              <VAT201SarsSubmit submissionId={savedId} exceptionsReady={exceptionsReady} exceptionsClean={exceptionsClean} />
            </>
          )}
        </div>
      </div>

      {showSubmitModal && (
        <VAT201SubmitModal
          sarsRef={sarsRef} submitting={submitting}
          onRefChange={setSarsRef}
          onConfirm={() => void markSubmitted()}
          onClose={() => { setShowSubmitModal(false); setSubmitBlockedCounts(null); setOverrideReason(''); }}
          blockingCounts={submitBlockedCounts}
          isOwnerOrAdmin={isOwnerOrAdmin}
          overrideReason={overrideReason}
          onOverrideReasonChange={setOverrideReason}
        />
      )}
    </AppLayout>
  );
}
