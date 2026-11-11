/**
 * EMP201 Form Page
 * Monthly PAYE/UIF/SDL return with auto-populated payroll data,
 * save draft and mark submitted actions.
 */

import { useState, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, Save, Send, AlertTriangle } from 'lucide-react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { Emp201DirectivePayments } from '@/components/payroll/Emp201DirectivePayments';
import { exportEmp201Csv, getDefaultPeriod, type EMP201Data } from '@/components/accounting/sars/emp201/emp201Types';
import { Emp201PageHeader } from '@/components/accounting/sars/emp201/Emp201PageHeader';
import { Emp201PeriodSelector } from '@/components/accounting/sars/emp201/Emp201PeriodSelector';
import { Emp201ReturnForm } from '@/components/accounting/sars/emp201/Emp201ReturnForm';
import { Emp201RunsBreakdown } from '@/components/accounting/sars/emp201/Emp201RunsBreakdown';
import { Emp201SubmitModal } from '@/components/accounting/sars/emp201/Emp201SubmitModal';
import { ReturnLifecycleBar } from '@/components/accounting/sars/returns/ReturnLifecycleBar';
import { useCompany } from '@/contexts/CompanyContext';

export default function EMP201Page() {
  const { companyRole } = useCompany();
  const defaults = getDefaultPeriod();
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [data, setData] = useState<EMP201Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [sarsRef, setSarsRef] = useState('');
  const [savedId, setSavedId] = useState('');
  const [showSubmitModal, setShowSubmitModal] = useState(false);

  const generate = useCallback(async () => {
    if (!from || !to) return;
    setLoading(true);
    setError('');
    setSuccess('');
    setData(null);
    setSavedId('');
    try {
      const res = await apiFetch(
        `/api/accounting/sars/sars-emp201?from=${from}&to=${to}`,
        { credentials: 'include' }
      );
      await assertOk(res, 'Could not generate the EMP201 - try again');
      const json = await res.json();
      setData(json.data);
    } catch (err) {
      setData(null); setError(apiErrorMessage(err, 'Could not generate the EMP201 - try again'));
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  const saveDraft = async () => {
    if (!data) return;
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/sars/sars-emp201', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ periodStart: from, periodEnd: to }),
      });
      await assertOk(res, 'Could not save the EMP201 draft - try again');
      const json = await res.json();
      setSavedId(json.data?.id || '');
      setSuccess('EMP201 draft saved successfully');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the EMP201 draft - try again'));
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
      await assertOk(res, 'Could not record the EMP201 as filed - try again');
      setSuccess('EMP201 recorded as filed on eFiling');
      setShowSubmitModal(false);
      setSarsRef('');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not record the EMP201 as filed - try again'));
    } finally {
      setSubmitting(false);
    }
  };

  const hasPayrollData = data && data.payrollRuns.length > 0;
  const directivePayments = data?.directivePayments ?? [];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <Emp201PageHeader canExport={Boolean(data)} onExport={() => { if (data) exportEmp201Csv(data, from, to); }} />

        <div className="p-6 space-y-6">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}
          {success && <div className="p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm">{success}</div>}

          <Emp201PeriodSelector from={from} to={to} loading={loading} onFromChange={setFrom} onToChange={setTo} onGenerate={generate} />

          {/* EMP201 Form */}
          {data && (
            <>
              {/* No payroll data warning */}
              {!hasPayrollData && directivePayments.length === 0 && (
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-4 text-sm text-[var(--ff-text-secondary)] flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <strong className="text-amber-400">No payroll data found.</strong>
                    <p className="mt-1">
                      Payroll tables (payroll_runs, payslips) may not exist yet or contain no data for
                      this period. All values are shown as zero. Once payroll is set up, this form will
                      populate automatically.
                    </p>
                  </div>
                </div>
              )}

              <Emp201ReturnForm data={data} />

              {hasPayrollData && <Emp201RunsBreakdown runs={data.payrollRuns} />}

              <Emp201DirectivePayments rows={directivePayments} />

              <ReturnLifecycleBar key={`${data.periodStart}:${data.periodEnd}`} form="EMP201"
                periodStart={data.periodStart} periodEnd={data.periodEnd} role={companyRole} />

              {/* Actions */}
              <div className="flex items-center gap-3">
                <button
                  onClick={saveDraft}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save Draft
                </button>
                {savedId && (
                  <button
                    onClick={() => setShowSubmitModal(true)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-success-700 text-white text-sm font-medium hover:bg-success-800"
                  >
                    <Send className="h-4 w-4" /> Record as filed on eFiling
                  </button>
                )}
              </div>
            </>
          )}

          {showSubmitModal && (
            <Emp201SubmitModal
              sarsRef={sarsRef} submitting={submitting} onRefChange={setSarsRef}
              onConfirm={markSubmitted} onClose={() => setShowSubmitModal(false)}
            />
          )}
        </div>
      </div>
    </AppLayout>
  );
}
