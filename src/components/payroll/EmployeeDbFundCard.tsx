/**
 * EmployeeDbFundCard (wave 6 DBF): the employer's defined-benefit pension or provident fund contributions (3817 / 3825
 * earnings) set by the fund member category factor, with Edit dates and End on each, and a form to add one. Each run values
 * such a row per the Seventh Schedule para 12D(3): factor x retirement-funding income, less the employee's compulsory
 * contributions to the fund, marked below (EmployeeDbFundContributionMarks; definedBenefitFund.ts). Each row also says what
 * the employer pays the fund (its amount: GL 2175, IRP5 4472 / 4473), and may be a para 12D(6) member (retired, or a
 * deceased member's dependant or nominee: no value, 4585 / 4586). The factor is the value on the fund's certificate for the employee's category
 * (para 12D(4)); the payroll never derives it. A defined-contribution fund (para 12D(2)) is entered as an amount or a % of
 * RFI instead. Shown only to the roles that may write pay detail (owner, admin, manager: the page's `mayWrite`, and the
 * route's withPayrollDetailAccess); the server also refuses a factor from a Login-as session (assignComponentToEmployee).
 */
import { useCallback, useEffect, useState } from 'react';
import { CalendarRange, Landmark, Loader2, X } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { DateField } from '@/components/ui';
import { Select } from '@/components/ui/Select';
import { todayInSast } from '@/lib/saDateParser';
import { formatDisplayDate } from '@/utils/dateFormat';
import { formatCurrency } from '@/utils/formatters';
import { AssignmentDatesEditor } from './AssignmentDatesEditor';
import { contributionRows, EmployeeDbFundContributionMarks, type ContributionRow } from './EmployeeDbFundContributionMarks';

interface CatalogueRow { id: string; name: string; sarsSourceCode: string; componentType: string }
export interface DbAssignmentRow extends ContributionRow {
  componentId: string; dbMemberCategoryFactor?: number | null; dbMemberRetired?: boolean;
}
interface Props {
  employeeId: string;
  refreshKey?: number;
  onChanged?: () => void;
  onEnd?: (assignmentId: string) => Promise<void> | void;
  onEditDates?: (assignmentId: string, effectiveFrom: string, effectiveTo: string | null) => Promise<void> | void;
}

const FAILED = 'Could not load the defined-benefit fund contributions - try again';
const ADD_FAILED = 'Could not add the defined-benefit contribution - try again';
const INPUT = 'w-full rounded-md border border-[var(--ff-border-primary)] bg-[var(--ff-surface-secondary)] px-3 py-2 text-sm text-[var(--ff-text-primary)]';
const ICON = 'p-1 rounded hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]';
export const FACTOR_HELP = 'The fund member category factor on the fund\'s certificate for this employee\'s category (para 12D(4)), as a '
  + 'fraction: 0.12 for 12%. Only for a defined-benefit or mixed fund; a defined-contribution fund is an amount or a % of RFI.';

/** A component a factor may go on: an employer pension (3817) or provident (3825) contribution earning (the server decides). */
export function isDbEligible(c: CatalogueRow): boolean {
  return c.componentType === 'earning' && ['3817', '3825'].includes(c.sarsSourceCode.trim());
}

/** "2200" or "2 200.50" → 2200.5; null unless it is an amount of 0 or more in cents. */
export function parseRand(text: string): number | null {
  const t = text.replace(/\s/g, '');
  return /^\d+(\.\d{1,2})?$/.test(t) ? Number(t) : null;
}

/** "0.12" → 0.12; null unless it is a number above 0 and at most 1 with at most four decimals. */
export function parseFactor(text: string): number | null {
  const t = text.trim();
  if (!/^(\d+(\.\d{1,4})?|\.\d{1,4})$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= 1 ? n : null;
}

export function EmployeeDbFundCard({ employeeId, refreshKey = 0, onChanged, onEnd, onEditDates }: Props) {
  const [catalogue, setCatalogue] = useState<CatalogueRow[]>([]);
  const [all, setAll] = useState<DbAssignmentRow[] | null>(null);
  const [error, setError] = useState('');
  const [componentId, setComponentId] = useState<string | null>(null);
  const [factorText, setFactorText] = useState('');
  const [paidText, setPaidText] = useState('');
  const [retired, setRetired] = useState(false);
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
      setAll(((await a.json()).data ?? []) as DbAssignmentRow[]);
    } catch (err) {
      setAll([]);
      setError(apiErrorMessage(err, FAILED));
    }
  }, [url]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const rows = (all ?? []).filter((r) => r.dbMemberCategoryFactor != null);
  const factor = parseFactor(factorText);
  const paid = parseRand(paidText);
  const add = async () => {
    if (!componentId || factor == null || paid == null || !from) return;
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch(url, { method: 'POST', body: JSON.stringify({ componentId, amount: paid, dbMemberCategoryFactor: factor, dbMemberRetired: retired, effectiveFrom: from, isRecurring: true }) });
      await assertOk(res, ADD_FAILED);
      setFactorText('');
      setPaidText('');
      setRetired(false);
      setComponentId(null);
      await load();
      onChanged?.();
    } catch (err) {
      setError(apiErrorMessage(err, ADD_FAILED));
    } finally {
      setSaving(false);
    }
  };

  const options = catalogue.filter(isDbEligible).map((c) => ({ value: c.id, label: `${c.name} (${c.sarsSourceCode.trim()})` }));
  return (
    <section aria-labelledby="db-fund-card-title" className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
      <h2 id="db-fund-card-title" className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--ff-text-primary)]">
        <Landmark className="h-4 w-4 text-teal-500" aria-hidden /> Defined-benefit fund contributions (para 12D)
      </h2>
      <p className="mb-3 text-xs text-[var(--ff-text-secondary)]">
        Each pay run values the employer&apos;s contribution as the fund member category factor x retirement-funding income, less the
        employee&apos;s own contributions to the fund: a non-cash taxable benefit, deemed paid by the employee for the retirement fund deduction.
      </p>
      {error && <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {all === null ? <Loader2 className="h-4 w-4 animate-spin text-teal-500" aria-label="Loading" /> : rows.length === 0 ? (
        <p className="mb-3 text-sm text-[var(--ff-text-tertiary)]">None set by a fund member category factor.</p>
      ) : (
        <ul className="mb-3 space-y-1 text-sm text-[var(--ff-text-primary)]">
          {rows.map((r) => (
            <li key={r.id}>
              <div className="flex items-center gap-2">
                <span className="flex-1"><span className="font-medium">{r.componentName}</span>: factor {Number(Number(r.dbMemberCategoryFactor).toFixed(4))},
                  employer pays {formatCurrency(r.amount)}{r.dbMemberRetired ? ', retired or dependant/nominee member (para 12D(6))' : ''}, from {formatDisplayDate(r.effectiveFrom)}{r.effectiveTo ? ` to ${formatDisplayDate(r.effectiveTo)}` : ''}</span>
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
      {all !== null && rows.length > 0 && <EmployeeDbFundContributionMarks url={url} rows={contributionRows(all, todayInSast())} onChanged={async () => { await load(); onChanged?.(); }} />}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_14rem_11rem_11rem_auto] lg:items-end">
        <Select id="db-component" label="Employer fund contribution" value={componentId} options={options} onChange={setComponentId}
          placeholder={options.length ? 'Select a 3817 or 3825 component…' : 'No 3817 or 3825 component'} />
        <div>
          <label htmlFor="db-factor" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">DB fund member category factor</label>
          <input id="db-factor" inputMode="decimal" className={INPUT} value={factorText} onChange={(e) => setFactorText(e.target.value)}
            placeholder="0.12" aria-describedby="db-factor-help" aria-invalid={factorText.trim() !== '' && factor == null} />
        </div>
        <div>
          <label htmlFor="db-paid" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Employer pays the fund (R a month)</label>
          <input id="db-paid" inputMode="decimal" className={INPUT} value={paidText} onChange={(e) => setPaidText(e.target.value)}
            placeholder="2200" aria-invalid={paidText.trim() !== '' && paid == null} />
        </div>
        <DateField label="Effective from" required value={from} onChange={(iso, v) => setFrom(v.valid ? iso : null)} />
        <button type="button" onClick={() => void add()} disabled={saving || !componentId || factor == null || paid == null || !from}
          className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add'}
        </button>
      </div>
      <label className="mt-2 flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
        <input type="checkbox" checked={retired} onChange={(e) => setRetired(e.target.checked)} />
        Retired or dependant/nominee member (para 12D(6)): no taxable value; the payment is reported as 4585 / 4586
      </label>
      <p id="db-factor-help" className="mt-2 text-xs text-[var(--ff-text-secondary)]">
        {factorText.trim() !== '' && factor == null ? 'Enter a fraction above 0 and at most 1, to four decimals. ' : ''}
        {paidText.trim() !== '' && paid == null ? 'Enter what the employer pays the fund, in rand and cents (0 if nothing). ' : ''}{FACTOR_HELP}
      </p>
    </section>
  );
}
