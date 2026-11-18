/**
 * DBF (#1571 round 2, M1): on the Defined-benefit fund card, the employee's pension (4001) and provident (4003) deduction
 * assignments, each with a checkbox marking it as the compulsory contribution to the defined-benefit fund. C in para 12D(3)
 * is the marked rows only (a voluntary contribution, buy-back or another fund's contribution is left unmarked); a run whose
 * line has such deductions and none marked is not approved. Each change is a PATCH …/components?aid= with
 * { dbFundMemberContribution }; the server refuses a Login-as session and audits the change.
 */
import { useState } from 'react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { formatDisplayDate } from '@/utils/dateFormat';

export interface ContributionRow {
  id: string; componentName: string; componentType: string; sarsSourceCode?: string; amount: number; percentOfRfi?: number | null;
  effectiveFrom: string; effectiveTo: string | null; dbFundMemberContribution?: boolean;
}
interface Props { url: string; rows: readonly ContributionRow[]; onChanged: () => Promise<void> | void }

const FAILED = 'Could not change the contribution mark - try again';

/** The employee's 4001 / 4003 deduction assignments that are live today or later. */
export function contributionRows(all: readonly ContributionRow[], today: string): ContributionRow[] {
  return all.filter((r) => r.componentType === 'deduction' && ['4001', '4003'].includes((r.sarsSourceCode ?? '').trim())
    && (r.effectiveTo == null || r.effectiveTo >= today));
}

export function EmployeeDbFundContributionMarks({ url, rows, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const toggle = async (r: ContributionRow, marked: boolean) => {
    setBusy(r.id);
    setError('');
    try {
      const res = await apiFetch(`${url}?aid=${encodeURIComponent(r.id)}`, { method: 'PATCH', body: JSON.stringify({ dbFundMemberContribution: marked }) });
      await assertOk(res, FAILED);
      await onChanged();
    } catch (err) {
      setError(apiErrorMessage(err, FAILED));
    } finally {
      setBusy(null);
    }
  };
  return (
    <fieldset className="mb-3 rounded-md border border-[var(--ff-border-primary)] px-3 py-2">
      <legend className="px-1 text-sm font-medium text-[var(--ff-text-primary)]">The employee&apos;s compulsory contribution to this fund</legend>
      <p className="mb-2 text-xs text-[var(--ff-text-secondary)]">
        Tick the pension (4001) or provident (4003) deduction the fund requires. Leave voluntary contributions, buy-back and other
        funds unticked: only ticked rows reduce the taxable value.
      </p>
      {error && <p role="alert" className="mb-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {rows.length === 0 ? <p className="text-sm text-[var(--ff-text-tertiary)]">No 4001 or 4003 deduction assigned: a non-contributory fund.</p> : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.id}>
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
                <input type="checkbox" checked={r.dbFundMemberContribution === true} disabled={busy !== null}
                  onChange={(e) => void toggle(r, e.target.checked)} />
                <span>{r.componentName} ({(r.sarsSourceCode ?? '').trim()}): {r.percentOfRfi != null ? `${Number((r.percentOfRfi * 100).toFixed(2))}% of RFI` : formatCurrency(r.amount)},
                  from {formatDisplayDate(r.effectiveFrom)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
