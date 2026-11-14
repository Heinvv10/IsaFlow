/**
 * VAT201 Form Page — thin shell
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, Save, Send } from 'lucide-react';
import { ListSkeleton } from '@/components/ui/ListSkeleton';
import { ApiRequestError, apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { VAT201PeriodSelector } from '@/components/accounting/sars/VAT201PeriodSelector';
import { VAT201PageHeader } from '@/components/accounting/sars/VAT201PageHeader';
import { VAT201ReviewNotices } from '@/components/accounting/sars/VAT201ReviewNotices';
import { Vat201FieldsSection } from '@/components/accounting/sars/Vat201FieldsSection';
import { useVat201Settings } from '@/components/accounting/sars/useVat201Settings';
import { useReturnDeepLink } from '@/components/accounting/sars/useReturnDeepLink';
import { buildVat201Csv } from '@/components/accounting/sars/vat201Csv';
import { VAT201SubmitModal } from '@/components/accounting/sars/VAT201SubmitModal';
import { VAT201ExceptionsPanel } from '@/components/accounting/sars/VAT201ExceptionsPanel';
import { VAT201SarsSubmit } from '@/components/accounting/sars/VAT201SarsSubmit';
import type { VatGateCounts } from '@/components/accounting/sars/VatGateOverrideBox';
import { ReturnLifecycleBar } from '@/components/accounting/sars/returns/ReturnLifecycleBar';
import { useCompany } from '@/contexts/CompanyContext';
import { useVatRegistration } from '@/hooks/useVatRegistration';
import { NotVatRegisteredNotice } from '@/components/accounting/NotVatRegisteredNotice';
import type { VatExceptionsReport } from '@/modules/accounting/services/reports/vatExceptionsTypes';
import type { Vat201FormWarning, Vat201SarsField } from '@/modules/accounting/services/reports/vat201SarsFields';
import type { VAT201Invoice } from '@/components/accounting/sars/VAT201FormSections';

interface VAT201Data { // the API also returns legacy field1..11 storage keys; the page uses only the SARS form
  periodStart: string; periodEnd: string;
  sarsFields: Vat201SarsField[];
  warnings: Vat201FormWarning[];
  filability: { filable: boolean; reason: string | null };
  outputInvoices: VAT201Invoice[]; inputInvoices: VAT201Invoice[];
}

const OVERRIDE_ROLES = ['owner', 'admin', 'super_admin'];

export default function VAT201Page() {
  const { companyRole } = useCompany();
  const isOwnerOrAdmin = OVERRIDE_ROLES.includes(companyRole ?? '');
  const { isRegistered, known } = useVatRegistration();
  const [error, setError] = useState('');
  const held = useRef(false);
  const { alignment, vatPeriod, quickPeriods, settingsReady, from, setFrom, to, setTo } = useVat201Settings(setError, held);
  const link = useReturnDeepLink(setFrom, setTo, held);
  const [data, setData] = useState<VAT201Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState('');
  const [sarsRef, setSarsRef] = useState('');
  const [savedId, setSavedId] = useState('');
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [submitBlockedCounts, setSubmitBlockedCounts] = useState<VatGateCounts | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [exceptionsKey, setExceptionsKey] = useState(0);
  const [exceptionsReport, setExceptionsReport] = useState<VatExceptionsReport | null>(null);
  const exceptionsReady = exceptionsReport !== null;
  const exceptionsClean = exceptionsReady && exceptionsReport.totalExceptions === 0 && !exceptionsReport.degradedData;

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

  // A link from Ask IsaFlow lands on the figure it quoted: Generate is a read, so it runs once the link's period and the VAT settings are in.
  const autoRanFor = useRef('');
  useEffect(() => {
    if (!link || !settingsReady || from !== link.from || to !== link.to) return;
    if (autoRanFor.current === `${link.from}|${link.to}`) return;
    autoRanFor.current = `${link.from}|${link.to}`;
    void generate();
  }, [link, settingsReady, from, to, generate]);

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
        throw new ApiRequestError(json?.error?.message || json?.message || 'Could not record the VAT201 as filed - try again', res.status);
      }
      setSuccess('VAT201 recorded as filed on eFiling');
      setShowSubmitModal(false); setSarsRef(''); setSubmitBlockedCounts(null); setOverrideReason('');
    } catch (err) { setError(apiErrorMessage(err, 'Could not record the VAT201 as filed - try again')); }
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
        <VAT201PageHeader canExport={Boolean(data)} onExport={exportCSV} />

        <div className="p-6 space-y-6">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}
          {success && <div className="p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm">{success}</div>}

          {known && !isRegistered && <NotVatRegisteredNotice surface="The VAT201 return" />}

          {known && isRegistered && !settingsReady && (
            <div data-testid="vat201-period-loading" className="h-[8.5rem]">
              <ListSkeleton rows={4} label="Loading VAT period settings" rowClassName="h-5 items-center" />
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
              <Vat201FieldsSection data={data} />

              <VAT201ReviewNotices warnings={data.warnings} filability={data.filability} />

              <VAT201ExceptionsPanel from={data.periodStart} to={data.periodEnd} reloadKey={exceptionsKey} onLoaded={setExceptionsReport} />

              <ReturnLifecycleBar form="VAT201"
                periodStart={data.periodStart} periodEnd={data.periodEnd} role={companyRole} />

              <div className="flex items-center gap-3">
                <button onClick={saveDraft} disabled={saving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 disabled:opacity-50">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Draft
                </button>
                {savedId && (
                  <button onClick={() => { setSubmitBlockedCounts(null); setOverrideReason(''); setShowSubmitModal(true); }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
                    <Send className="h-4 w-4" /> Record as filed on eFiling
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
          filabilityWarning={data && !data.filability.filable ? data.filability.reason : null}
        />
      )}
    </AppLayout>
  );
}
