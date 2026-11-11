/**
 * EmployeeRfiContributionsCard (wave 5 RF): the employee's retirement fund contributions set as a percentage of
 * retirement-funding income (RFI), and a form to add one. Each run costs such a row at round2(percent x RFI), RFI being the
 * line's earnings flagged "Counts as retirement-funding income" on the pay components page. Only a pension, provident or
 * RA contribution can be a percentage: the employee's own (deduction 4001 / 4003 / 4006) or the employer's (earning
 * 3817 / 3825 / 3828, a non-cash taxable benefit deemed paid by the employee). RFI is the fund's base, never a tax limit.
 * The rows are payroll_employee_components with percent_of_rfi (POST /api/payroll/employees/:id/components); End and
 * Edit dates stay on the Pay Components card above, where they show at R 0.00 (the run decides the figure).
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, PiggyBank } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { DateField } from '@/components/ui';
import { Select } from '@/components/ui/Select';
import { todayInSast } from '@/lib/saDateParser';
import { formatDisplayDate } from '@/utils/dateFormat';
import { EMPLOYER_FUND_BENEFIT_CODES, RETIREMENT_CONTRIBUTION_CODES } from '@/modules/accounting/services/payroll/retirementFundCodes';

interface CatalogueRow { id: string; name: string; sarsSourceCode: string; componentType: string }
interface AssignmentRow { id: string; componentId: string; componentName: string; effectiveFrom: string; effectiveTo: string | null; percentOfRfi: number | null }

const FAILED = 'Could not load the retirement fund contributions - try again';
const INPUT = 'w-full rounded-md border border-[var(--ff-border-primary)] bg-[var(--ff-surface-secondary)] px-3 py-2 text-sm text-[var(--ff-text-primary)]';
const DEDUCTIONS = new Set<string>(RETIREMENT_CONTRIBUTION_CODES);
const EMPLOYER = new Set<string>(EMPLOYER_FUND_BENEFIT_CODES);

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

export function EmployeeRfiContributionsCard({ employeeId, refreshKey = 0, onChanged }: { employeeId: string; refreshKey?: number; onChanged?: () => void }) {
  const [catalogue, setCatalogue] = useState<CatalogueRow[]>([]);
  const [rows, setRows] = useState<AssignmentRow[] | null>(null);
  const [error, setError] = useState('');
  const [componentId, setComponentId] = useState<string | null>(null);
  const [percent, setPercent] = useState('');
  const [from, setFrom] = useState<string | null>(todayInSast());
  const [saving, setSaving] = useState(false);
  const url = `/api/payroll/employees/${employeeId}/components`;

  const load = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([apiFetch('/api/payroll/components'), apiFetch(url)]);
      await assertOk(c, FAILED);
      await assertOk(a, FAILED);
      setCatalogue(((await c.json()).data ?? []) as CatalogueRow[]);
      setRows((((await a.json()).data ?? []) as AssignmentRow[]).filter((r) => r.percentOfRfi != null));
    } catch (err) {
      setRows([]);
      setError(apiErrorMessage(err, FAILED));
    }
  }, [url]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const fraction = percentToFraction(percent);
  const add = async () => {
    if (!componentId || fraction == null || !from) return;
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
      {rows === null ? <Loader2 className="h-4 w-4 animate-spin text-teal-500" aria-label="Loading" /> : rows.length === 0 ? (
        <p className="mb-3 text-sm text-[var(--ff-text-tertiary)]">None set as a percentage of retirement-funding income.</p>
      ) : (
        <ul className="mb-3 space-y-1 text-sm text-[var(--ff-text-primary)]">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="font-medium">{r.componentName}</span>: {Number(((r.percentOfRfi ?? 0) * 100).toFixed(2))}% of retirement-funding income,
              from {formatDisplayDate(r.effectiveFrom)}{r.effectiveTo ? ` to ${formatDisplayDate(r.effectiveTo)}` : ''}
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
