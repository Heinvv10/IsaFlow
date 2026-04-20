/**
 * Payroll Year-End Guided Workflow — /payroll/year-end
 * Stepped checklist that orchestrates existing IRP5/EMP501/e@syFile/lockdown
 * flows. Status is polled from /api/payroll/year-end/status.
 */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  CalendarCheck, Loader2, AlertCircle, CheckCircle2, Circle, ArrowRight, Download,
  AlertTriangle, ExternalLink,
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';

interface YearEndStatus {
  taxYear: number;
  companyProfile: { complete: boolean; missing: string[] };
  employees: { total: number; withPayroll: number };
  payrollRuns: { monthsCovered: number; totalPaye: number };
  readiness: { errors: number; warnings: number; componentIssues: number; certificatesReady: number };
  emp501: { balanced: boolean; totalEmp201: number; totalIrp5: number; totalVariance: number };
  periodLock: { locked: boolean; lockdownDate: string | null };
}

type StepState = 'done' | 'pending' | 'blocked';

interface Step {
  id: string;
  title: string;
  description: string;
  state: StepState;
  detail?: string;
  action?: { label: string; href?: string; onClick?: () => void; external?: boolean };
}

function StateIcon({ state }: { state: StepState }) {
  if (state === 'done') return <CheckCircle2 className="h-5 w-5 text-teal-400" />;
  if (state === 'blocked') return <AlertTriangle className="h-5 w-5 text-red-400" />;
  return <Circle className="h-5 w-5 text-[var(--ff-text-tertiary)]" />;
}

function taxYearLabel(y: number) {
  return `${y - 1}/${y} (Mar ${y - 1} – Feb ${y})`;
}

export default function YearEndPage() {
  const currentTaxYear = new Date().getMonth() >= 2 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  const [taxYear, setTaxYear] = useState(currentTaxYear + 1);
  const [status, setStatus] = useState<YearEndStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/year-end/status?taxYear=${taxYear}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: YearEndStatus };
      setStatus(json.data ?? null);
    } catch {
      setError('Failed to load year-end status');
    } finally {
      setIsLoading(false);
    }
  }, [taxYear]);

  useEffect(() => { void load(); }, [load]);

  const handleEasyFileDownload = async () => {
    setDownloadError(null);
    try {
      const res = await apiFetch(`/api/payroll/irp5/easyfile-export?taxYear=${taxYear}`);
      if (!res.ok) {
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        setDownloadError(json?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `IRP5_${taxYear - 1}_${taxYear}.irp5`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed');
    }
  };

  const steps: Step[] = buildSteps(status, handleEasyFileDownload);
  const completedCount = steps.filter((s) => s.state === 'done').length;
  const yearOptions = [currentTaxYear, currentTaxYear + 1, currentTaxYear + 2];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <CalendarCheck className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Year-End Workflow</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Guided IRP5 / EMP501 / e@syFile submission</p>
              </div>
            </div>
            <select
              value={taxYear}
              onChange={(e) => setTaxYear(Number(e.target.value))}
              className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              {yearOptions.map((y) => <option key={y} value={y}>{taxYearLabel(y)}</option>)}
            </select>
          </div>
        </div>

        <div className="p-6 max-w-4xl space-y-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-4">
              <AlertCircle className="h-5 w-5" /><span>{error}</span>
            </div>
          ) : status && (
            <>
              <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-4 flex items-center justify-between">
                <div>
                  <p className="text-xs text-[var(--ff-text-tertiary)] uppercase tracking-wide">Progress</p>
                  <p className="text-2xl font-bold text-[var(--ff-text-primary)]">
                    {completedCount} / {steps.length}
                  </p>
                  <p className="text-xs text-[var(--ff-text-secondary)] mt-1">steps complete for {taxYearLabel(taxYear)}</p>
                </div>
                <div className="flex-1 ml-6 h-2 rounded-full bg-[var(--ff-bg-tertiary)] overflow-hidden">
                  <div
                    className="h-full bg-teal-500 transition-all"
                    style={{ width: `${Math.round((completedCount / steps.length) * 100)}%` }}
                  />
                </div>
              </div>

              {downloadError && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/5 text-sm text-red-300 px-3 py-2 flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{downloadError}</span>
                </div>
              )}

              <ol className="space-y-3">
                {steps.map((step, idx) => (
                  <li
                    key={step.id}
                    className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-4"
                  >
                    <div className="flex items-start gap-4">
                      <div className="pt-0.5"><StateIcon state={step.state} /></div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-[var(--ff-text-tertiary)]">Step {idx + 1}</span>
                          <span className="text-sm font-medium text-[var(--ff-text-primary)]">{step.title}</span>
                        </div>
                        <p className="text-xs text-[var(--ff-text-secondary)] mt-1">{step.description}</p>
                        {step.detail && (
                          <p className="text-xs text-[var(--ff-text-tertiary)] mt-2">{step.detail}</p>
                        )}
                      </div>
                      {step.action && (
                        step.action.href ? (
                          step.action.external ? (
                            <a
                              href={step.action.href}
                              target="_blank"
                              rel="noreferrer"
                              className="shrink-0 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--ff-border-primary)] text-xs text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]"
                            >
                              {step.action.label} <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <Link
                              href={step.action.href}
                              className="shrink-0 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--ff-border-primary)] text-xs text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]"
                            >
                              {step.action.label} <ArrowRight className="h-3 w-3" />
                            </Link>
                          )
                        ) : (
                          <button
                            onClick={step.action.onClick}
                            className="shrink-0 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-xs text-white font-medium"
                          >
                            <Download className="h-3 w-3" /> {step.action.label}
                          </button>
                        )
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

function buildSteps(status: YearEndStatus | null, downloadEasyFile: () => void): Step[] {
  if (!status) return [];

  const hasRuns = status.payrollRuns.monthsCovered > 0;
  const blockedByProfile: StepState = status.companyProfile.complete ? 'done' : 'pending';

  return [
    {
      id: 'profile',
      title: 'Complete company tax profile',
      description: 'PAYE/SDL/UIF references, SARS contact, and physical address must be captured before IRP5 certificates can be generated.',
      state: status.companyProfile.complete ? 'done' : 'blocked',
      detail: status.companyProfile.missing.length > 0
        ? `Missing: ${status.companyProfile.missing.join(', ')}`
        : undefined,
      action: status.companyProfile.complete
        ? undefined
        : { label: 'Open Company Settings', href: '/accounting/settings/company' },
    },
    {
      id: 'runs',
      title: 'Post payroll runs for the tax year',
      description: 'All months Mar–Feb must have at least one approved or posted run.',
      state: hasRuns ? 'done' : 'pending',
      detail: `${status.payrollRuns.monthsCovered} of 12 months covered · total PAYE ${formatCurrency(status.payrollRuns.totalPaye)}`,
      action: { label: 'Payroll Runs', href: '/payroll/runs' },
    },
    {
      id: 'readiness',
      title: 'Fix IRP5 readiness issues',
      description: 'Resolve all errors in the validation engine before generating certificates.',
      state: status.readiness.errors === 0 && status.readiness.componentIssues === 0 ? 'done' : 'blocked',
      detail: `${status.readiness.certificatesReady} certificates ready · ${status.readiness.errors} errors · ${status.readiness.warnings} warnings · ${status.readiness.componentIssues} component issues`,
      action: { label: 'IRP5 Readiness', href: '/payroll/irp5' },
    },
    {
      id: 'emp501',
      title: 'Reconcile EMP501',
      description: 'Total declared EMP201 PAYE must equal the sum of IRP5 PAYE before submission.',
      state: status.emp501.balanced ? 'done' : 'pending',
      detail: status.emp501.totalEmp201 > 0
        ? `EMP201 ${formatCurrency(status.emp501.totalEmp201)} · IRP5 ${formatCurrency(status.emp501.totalIrp5)} · variance ${formatCurrency(Math.abs(status.emp501.totalVariance))}`
        : 'No EMP501 data yet — post runs first',
      action: { label: 'EMP501', href: '/payroll/emp501' },
    },
    {
      id: 'easyfile',
      title: 'Generate e@syFile IRP5 import',
      description: 'Download the .irp5 file per SARS BRS v25.2, ready to import into the SARS e@syFile Thin Client.',
      state: blockedByProfile === 'done' && hasRuns && status.readiness.errors === 0 ? 'pending' : 'blocked',
      action: blockedByProfile === 'done' && hasRuns
        ? { label: 'Download', onClick: downloadEasyFile }
        : undefined,
    },
    {
      id: 'submit',
      title: 'Submit reconciliation on SARS e@syFile',
      description: 'Import the .irp5 file into e@syFile Thin Client, reconcile with EMP201 declarations, and submit to SARS.',
      state: 'pending',
      action: {
        label: 'Open SARS e@syFile',
        href: 'https://www.sars.gov.za/businesses-and-employers/my-business-and-tax/easyfile/',
        external: true,
      },
    },
    {
      id: 'lock',
      title: 'Lock the financial year',
      description: 'Apply company lockdown at Feb 28 to prevent retrospective changes to closed payroll periods.',
      state: status.periodLock.locked ? 'done' : 'pending',
      detail: status.periodLock.lockdownDate ? `Locked to: ${status.periodLock.lockdownDate}` : 'Not locked',
      action: { label: 'Company Lockdown', href: '/accounting/settings/company' },
    },
  ];
}
