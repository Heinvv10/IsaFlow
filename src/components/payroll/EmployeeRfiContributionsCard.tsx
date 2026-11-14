/**
 * EmployeeRfiContributionsCard (wave 5 RF): the employee's retirement fund contributions set as a percentage of
 * retirement-funding income (RFI), with Edit dates and End on each, and a form to add one. Each run costs such a row at
 * round2(percent x RFI), RFI being the line's earnings flagged "Counts as retirement-funding income" on the pay components
 * page. Only a pension, provident or RA contribution can be a percentage: the employee's own (deduction 4001 / 4003 / 4006)
 * or the employer's (earning 3817 / 3825 / 3828, a non-cash taxable benefit deemed paid by the employee). RFI is the fund's
 * base, never a tax limit. A pre-RF employer fund row kept as cash (migration 975) is listed with how to switch, as the run's
 * EMPLOYER_FUND_KEPT_AS_CASH warning says. Rows are payroll_employee_components (POST/PATCH/DELETE
 * /api/payroll/employees/:id/components); End and Edit dates are the page's own actions (useEmployeeDetail).
 */
import { useCallback, useEffect, useState } from 'react';
import { CalendarRange, Loader2, PiggyBank, X } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { DateField } from '@/components/ui';
import { Select } from '@/components/ui/Select';
import { todayInSast } from '@/lib/saDateParser';
import { formatCurrency } from '@/utils/formatters';
import { formatDisplayDate } from '@/utils/dateFormat';
import { AssignmentDatesEditor } from './AssignmentDatesEditor';
import { EMPLOYER_FUND_BENEFIT_CODES, RETIREMENT_CONTRIBUTION_CODES } from '@/modules/accounting/services/payroll/retirementFundCodes';

interface CatalogueRow { id: string; name: string; sarsSourceCode: string; componentType: string }
export interface RfiAssignmentRow {
  id: string; componentId: string; componentName: string; amount: number; effectiveFrom: string; effectiveTo: string | null;
  percentOfRfi: number | null; employerFundAsCash?: boolean;
}
interface Props {
  employeeId: string;
  refreshKey?: number;
  onChanged?: () => void;
  onEnd?: (assignmentId: string) => Promise<void> | void;
  onEditDates?: (assignmentId: string, effectiveFrom: string, effectiveTo: string | null) => Promise<void> | void;
}

const FAILED = 'Could not load the retirement fund contributions - try again';
const INPUT = 'w-full rounded-md border border-[var(--ff-border-primary)] bg-[var(--ff-surface-secondary)] px-3 py-2 text-sm text-[var(--ff-text-primary)]';
const ICON = 'p-1 rounded hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]';
const DEDUCTIONS = new Set<string>(RETIREMENT_CONTRIBUTION_CODES);
const EMPLOYER = new Set<string>(EMPLOYER_FUND_BENEFIT_CODES);
const pct = (f: number | null) => `${Number(((f ?? 0) * 100).toFixed(2))}%`;

/** A component a percentage may go on (the server's rfi.percentOfRfiRefusal decides; this only filters the list). */
export function isRfiEligible(c: CatalogueRow): boolean {
  const code = c.sarsSourceCode.trim();
  return (c.componentType === 'deduction' && DEDUCTIONS.has(code)) || (c.componentType === 'earning' && EMPLOYER.has(code));
}

/** "7.5" → 0.075, to four decimals; null when it is not a percentage above 0 and at most 100. */
export function percentToFraction(text: string): number | null {
  const n = Number(text.trim());
  if (!text.trim() || !Number.isFinite(n) || n <= 0 || n > 100) return null;
  return Math.round(n * 100) / 10_000;
}

/** An open row of the same component that a new one from `from` would overlap, said in plain words; null when none. */
export function overlapMessage(rows: readonly RfiAssignmentRow[], componentId: string, from: string): string | null {
  const open = rows.find((r) => r.componentId === componentId && (r.effectiveTo == null || r.effectiveTo >= from));
  if (!open) return null;
  const what = open.percentOfRfi != null ? `${pct(open.percentOfRfi)} of retirement-funding income` : formatCurrency(open.amount);
  return `${open.componentName} already runs from ${formatDisplayDate(open.effectiveFrom)} (${what}). End it, or edit its dates, before adding another.`;
}

export function EmployeeRfiContributionsCard({ employeeId, refreshKey = 0, onChanged, onEnd, onEditDates }: Props) {
  const [catalogue, setCatalogue] = useState<CatalogueRow[]>([]);
  const [all, setAll] = useState<RfiAssignmentRow[] | null>(null);
  const [error, setError] = useState('');
  const [componentId, setComponentId] = useState<string | null>(null);
  const [percent, setPercent] = useState('');
  const [from, setFrom] = useState<string | null>(todayInSast());
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const url = `/api/payroll/employees/${employeeId}/components`;

  const load = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([apiFetch('/api/payroll/components'), apiFetch(url)]);
      await assertOk(c, FAILED);
      await assertOk(a, FAILED);
      setCatalogue(((await c.json()).data ?? []) as CatalogueRow[]);
      setAll(((await a.json()).data ?? []) as RfiAssignmentRow[]);
    } catch (err) {
      setAll([]);
      setError(apiErrorMessage(err, FAILED));
    }
  }, [url]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const rows = (all ?? []).filter((r) => r.percentOfRfi != null);
  const kept = (all ?? []).filter((r) => r.employerFundAsCash === true && (r.effectiveTo == null || r.effectiveTo >= todayInSast()));
  const fraction = percentToFraction(percent);
  const add = async () => {
    if (!componentId || fraction == null || !from) return;
    const overlap = overlapMessage(all ?? [], componentId, from);
    if (overlap) { setError(overlap); return; }
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch(url, { method: 'POST', body: JSON.stringify({ componentId, amount: 0, percentOfRfi: fraction, effectiveFrom: from, isRecurring: true }) });
      await assertOk(res, 'Could not add the contribution - try again');
      setPercent('');
      setComponentId(null);
      await load();
      onChanged?.();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not add the contribution - try again'));
    } finally {
      setSaving(false);
    }
  };

  const options = catalogue.filter(isRfiEligible).map((c) => ({ value: c.id, label: `${c.name} (${c.sarsSourceCode.trim()})` }));
  return (
    <section aria-labelledby="rfi-card-title" className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
      <h2 id="rfi-card-title" className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--ff-text-primary)]">
        <PiggyBank className="h-4 w-4 text-teal-500" aria-hidden /> Retirement fund contributions (% of RFI)
      </h2>
      <p className="mb-3 text-xs text-[var(--ff-text-secondary)]">
        Costed by each pay run on the earnings that count as retirement-funding income (pay components page). An employer contribution is a
        non-cash taxable benefit, deemed paid by the employee for the retirement fund deduction. RFI is the fund&apos;s base, not a tax limit.
      </p>
      {error && <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {kept.map((r) => (
        <p key={r.id} role="note" className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
          {r.componentName} ({formatCurrency(r.amount)}, from {formatDisplayDate(r.effectiveFrom)}) was assigned before employer retirement contributions were
          supported, so it is still paid as cash and not counted as the employee&apos;s contribution. If the employer pays it to the fund, end it and add it here
          as a % of retirement-funding income from the next month.
        </p>
      ))}
      {all === null ? <Loader2 className="h-4 w-4 animate-spin text-teal-500" aria-label="Loading" /> : rows.length === 0 ? (
        <p className="mb-3 text-sm text-[var(--ff-text-tertiary)]">None set as a percentage of retirement-funding income.</p>
      ) : (
        <ul className="mb-3 space-y-1 text-sm text-[var(--ff-text-primary)]">
          {rows.map((r) => (
            <li key={r.id}>
              <div className="flex items-center gap-2">
                <span className="flex-1"><span className="font-medium">{r.componentName}</span>: {pct(r.percentOfRfi)} of retirement-funding income,
                  from {formatDisplayDate(r.effectiveFrom)}{r.effectiveTo ? ` to ${formatDisplayDate(r.effectiveTo)}` : ''}</span>
                {onEditDates && <button type="button" className={ICON} aria-label={`Edit dates for ${r.componentName}`} title="Edit dates"
                  onClick={() => setEditingId(editingId === r.id ? null : r.id)}><CalendarRange className="h-4 w-4" /></button>}
                {onEnd && !r.effectiveTo && <button type="button" className={ICON} aria-label={`End ${r.componentName}`} title="End"
                  onClick={() => void onEnd(r.id)}><X className="h-4 w-4" /></button>}
              </div>
              {onEditDates && editingId === r.id && (
                <AssignmentDatesEditor componentName={r.componentName} effectiveFrom={r.effectiveFrom} effectiveTo={r.effectiveTo}
                  onCancel={() => setEditingId(null)} onSave={async (f, t) => { await onEditDates(r.id, f, t); setEditingId(null); }} />
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_8rem_12rem_auto] sm:items-end">
        <Select id="rfi-component" label="Contribution" value={componentId} options={options} onChange={setComponentId}
          placeholder={options.length ? 'Select a contribution…' : 'No 4001/4003/4006 or 3817/3825/3828 component'} />
        <div>
          <label htmlFor="rfi-percent" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">% of RFI</label>
          <input id="rfi-percent" inputMode="decimal" className={INPUT} value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="7.5" />
        </div>
        <DateField label="Effective from" required value={from} onChange={(iso, v) => setFrom(v.valid ? iso : null)} />
        <button type="button" onClick={() => void add()} disabled={saving || !componentId || fraction == null || !from}
          className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add'}
        </button>
      </div>
    </section>
  );
}
