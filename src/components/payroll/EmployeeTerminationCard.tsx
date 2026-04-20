/**
 * Employee termination details — BCEA leave pay-out, notice pay, severance.
 *
 * Values flow into the next payroll run automatically (see
 * payrollRunService.appendTerminationIfEndingThisPeriod) when the employee's
 * end_date falls in the run period and a reason is captured here.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { AlertCircle, AlertTriangle, ArrowRight, CheckCircle2, Loader2, LogOut, Save } from 'lucide-react';

type Reason = 'resignation' | 'dismissal' | 'retrenchment' | 'retirement' | 'end_of_contract' | 'death';

interface TerminationDetails {
  reason: Reason | null;
  noticePeriodDays: number | null;
  servedNoticeDays: number | null;
  severanceWeeksPerYear: number | null;
  includeLeavePayout: boolean;
}

interface TerminationContext {
  endDate: string | null;
  monthlySalary: number;
  annualLeaveBalance: number;
  yearsOfService: number | null;
  hasApprovedSeveranceDirective: boolean;
}

interface TerminationPreview {
  leavePayout: number;
  noticePay: number;
  severancePay: number;
  total: number;
}

interface Props {
  employeeId: string;
  endDate: string | null;
}

const REASON_LABELS: Record<Reason, string> = {
  resignation: 'Resignation',
  dismissal: 'Dismissal',
  retrenchment: 'Retrenchment',
  retirement: 'Retirement',
  end_of_contract: 'End of contract',
  death: 'Death',
};

const LABEL = 'block text-xs text-[var(--ff-text-secondary)] mb-1';
const INPUT = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-sm text-[var(--ff-text-primary)] focus:outline-none focus:ring-1 focus:ring-teal-500';

export function EmployeeTerminationCard({ employeeId, endDate }: Props) {
  const [details, setDetails] = useState<TerminationDetails>({
    reason: null,
    noticePeriodDays: 30,
    servedNoticeDays: 30,
    severanceWeeksPerYear: 1,
    includeLeavePayout: true,
  });
  const [context, setContext] = useState<TerminationContext | null>(null);
  const [preview, setPreview] = useState<TerminationPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/payroll/employees/${employeeId}/termination`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as {
        data?: { details: TerminationDetails; context: TerminationContext; preview: TerminationPreview | null };
      };
      const d = json.data;
      if (d) {
        setDetails({ ...details, ...d.details });
        setContext(d.context);
        setPreview(d.preview);
      }
    } catch {
      setMsg({ kind: 'err', text: 'Failed to load termination details' });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetch(`/api/payroll/employees/${employeeId}/termination`, {
        method: 'PUT',
        body: JSON.stringify(details),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(j.error?.message ?? `HTTP ${res.status}`);
      }
      setMsg({ kind: 'ok', text: 'Termination details saved' });
      await load();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-5">
      <div className="flex items-center gap-2 mb-4">
        <LogOut className="h-4 w-4 text-[var(--ff-text-secondary)]" />
        <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Termination</h2>
        {!endDate && (
          <span className="ml-2 text-xs text-[var(--ff-text-tertiary)]">
            Set an end date on the profile to enable termination pay calculation
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className={LABEL}>Reason</label>
              <select
                className={INPUT}
                value={details.reason ?? ''}
                onChange={(e) => setDetails({ ...details, reason: (e.target.value || null) as Reason | null })}
                disabled={!endDate}
              >
                <option value="">—</option>
                {Object.entries(REASON_LABELS).map(([v, label]) => (
                  <option key={v} value={v}>{label}</option>
                ))}
              </select>
              <p className="text-[10px] text-[var(--ff-text-tertiary)] mt-1">Severance only applies for retrenchment (BCEA s41).</p>
            </div>
            <div>
              <label className={LABEL}>Contractual notice period (days)</label>
              <input
                type="number" min={0} className={INPUT}
                value={details.noticePeriodDays ?? ''}
                onChange={(e) => setDetails({ ...details, noticePeriodDays: e.target.value === '' ? null : Number(e.target.value) })}
                disabled={!endDate}
              />
            </div>
            <div>
              <label className={LABEL}>Notice days served</label>
              <input
                type="number" min={0} className={INPUT}
                value={details.servedNoticeDays ?? ''}
                onChange={(e) => setDetails({ ...details, servedNoticeDays: e.target.value === '' ? null : Number(e.target.value) })}
                disabled={!endDate}
              />
            </div>
            <div>
              <label className={LABEL}>Severance weeks per year</label>
              <input
                type="number" min={0} step="0.5" className={INPUT}
                value={details.severanceWeeksPerYear ?? ''}
                onChange={(e) => setDetails({ ...details, severanceWeeksPerYear: e.target.value === '' ? null : Number(e.target.value) })}
                disabled={!endDate}
              />
              <p className="text-[10px] text-[var(--ff-text-tertiary)] mt-1">BCEA minimum is 1 week per year of completed service (retrenchment only).</p>
            </div>
            <div className="md:col-span-2 flex items-center gap-2">
              <input
                id="includeLeavePayout"
                type="checkbox"
                checked={details.includeLeavePayout}
                onChange={(e) => setDetails({ ...details, includeLeavePayout: e.target.checked })}
                disabled={!endDate}
              />
              <label htmlFor="includeLeavePayout" className="text-sm text-[var(--ff-text-secondary)]">
                Include accrued annual-leave pay-out
              </label>
            </div>
          </div>

          {context && (
            <div className="mt-4 p-3 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)] text-xs text-[var(--ff-text-secondary)] space-y-1">
              <div>End date: <span className="text-[var(--ff-text-primary)]">{context.endDate ?? 'Not set'}</span></div>
              <div>Monthly salary: <span className="text-[var(--ff-text-primary)]">{formatCurrency(context.monthlySalary)}</span></div>
              <div>Annual-leave balance: <span className="text-[var(--ff-text-primary)]">{context.annualLeaveBalance.toFixed(2)} days</span></div>
              {context.yearsOfService != null && (
                <div>Years of service: <span className="text-[var(--ff-text-primary)]">{context.yearsOfService.toFixed(2)}</span></div>
              )}
            </div>
          )}

          {preview && (
            <div className="mt-4 grid grid-cols-1 md:grid-cols-4 gap-3">
              <PreviewCard label="Leave pay-out" value={preview.leavePayout} />
              <PreviewCard label="Notice pay" value={preview.noticePay} />
              <PreviewCard label="Severance" value={preview.severancePay} />
              <PreviewCard label="Total" value={preview.total} highlight />
            </div>
          )}

          {preview && preview.severancePay > 0 && context && !context.hasApprovedSeveranceDirective && (
            <div className="mt-4 rounded-lg border border-yellow-500/30 bg-yellow-500/5 text-yellow-300 text-sm p-3 flex items-start gap-3">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="font-medium">Severance tax directive missing</p>
                <p className="text-xs text-yellow-200/80 mt-0.5">
                  Severance is a SARS lump-sum payment. Without an approved tax directive, PAYE will be
                  calculated at the normal monthly rate and almost certainly be wrong. Apply for a directive
                  and link it before the payroll run.
                </p>
              </div>
              <Link
                href="/payroll/tax-directives"
                className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-yellow-500/20 hover:bg-yellow-500/30"
              >
                Tax Directives <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          )}

          {preview && preview.severancePay > 0 && context?.hasApprovedSeveranceDirective && (
            <div className="mt-4 rounded-lg border border-teal-500/30 bg-teal-500/5 text-teal-300 text-xs p-3 flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              <span>Approved severance tax directive on file for this employee.</span>
            </div>
          )}

          {msg && (
            <div className={`mt-4 rounded-lg border px-3 py-2 text-sm flex items-start gap-2 ${
              msg.kind === 'ok'
                ? 'border-teal-500/30 bg-teal-500/5 text-teal-300'
                : 'border-red-500/30 bg-red-500/5 text-red-300'
            }`}>
              {msg.kind === 'ok' ? <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" /> : <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />}
              <span>{msg.text}</span>
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !endDate}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-sm text-white font-medium"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save Termination Details
            </button>
          </div>

          <p className="text-[10px] text-[var(--ff-text-tertiary)] mt-3">
            Saved values are injected into the payroll run for the month containing the end date.
            Severance is a lump sum &mdash; obtain a SARS tax directive and adjust PAYE via the Tax Directives page if needed.
          </p>
        </>
      )}
    </div>
  );
}

function PreviewCard({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`p-3 rounded-lg ${highlight ? 'bg-teal-500/10 border border-teal-500/30' : 'bg-[var(--ff-bg-tertiary)]'}`}>
      <p className="text-[10px] text-[var(--ff-text-tertiary)] uppercase tracking-wide">{label}</p>
      <p className={`text-lg font-semibold ${highlight ? 'text-teal-300' : 'text-[var(--ff-text-primary)]'}`}>{formatCurrency(value)}</p>
    </div>
  );
}
