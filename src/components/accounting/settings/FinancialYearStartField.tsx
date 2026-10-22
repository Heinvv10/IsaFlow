/**
 * Settings -> General: the financial year start month.
 *
 * Read-only once a journal has posted, while the periods are otherwise in use,
 * or for a company other than the active one: PUT /api/accounting/companies
 * refuses a change in each case
 * (gl/fiscalYearStartChange.ts). When read-only it shows the month the BOOKS use
 * (period 1 of the latest fiscal year), which can differ from the declared
 * month: companies onboarded before 2026-10-22 declare March while their periods
 * run January–December. A difference is always spelled out, and honestly: some
 * readers take year ranges from the periods, others (trial balance YTD, AFS
 * ranges, the year-end close) from the declared month.
 */
import { YEAR_END_CHANGE_MESSAGE } from '@/modules/accounting/services/gl/financialYearStartMessages';
import { Company, INPUT_CLS, LABEL_CLS } from './settingsTypes';

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];
const NOTE_CLS = 'text-xs text-[var(--ff-text-tertiary)] mt-1';

interface Props {
  company: Company;
  onChange: (field: keyof Company, value: unknown) => void;
}

export function FinancialYearStartField({ company, onChange }: Props) {
  const declared = company.financialYearStart;
  const actual = company.financialYearStartActual;
  const locked = company.financialYearStartLocked;
  const reason = company.financialYearStartLockReason;
  const mismatch = actual !== null && actual !== declared;
  // Locked: the month the books use. Editable: the month a save writes (the declared one).
  const shown = locked && actual !== null ? actual : declared;

  return (
    <div>
      <label htmlFor="settings-financial-year-start" className={LABEL_CLS}>Financial Year Start Month</label>
      <select id="settings-financial-year-start" className={INPUT_CLS} value={shown} disabled={locked}
        onChange={e => onChange('financialYearStart', Number(e.target.value))}>
        {SHORT.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
      </select>
      {reason === 'not_active' && <p className={NOTE_CLS}>Switch to this company to change its financial year start.</p>}
      {(reason === 'posted' || reason === 'in_use') && (
        <p className={NOTE_CLS}>
          {reason === 'posted'
            ? 'Locked because journals have been posted. '
            : "Locked because this company's fiscal periods are already in use (draft journals, budgets, AFS documents or closed periods). "}
          {YEAR_END_CHANGE_MESSAGE}
        </p>
      )}
      {mismatch && (
        <p className="text-xs text-amber-400 mt-1">
          {`Your fiscal periods run from ${LONG[actual - 1]}, but the declared financial year start is ${LONG[declared - 1]}. `
            // Editable means nothing uses the periods: a change to that month rebuilds them on it and aligns the two.
            + (locked
              ? "Some reports use one and some the other until they're aligned; contact support to align them."
              : `Choose ${LONG[actual - 1]} and save to align them.`)}
        </p>
      )}
    </div>
  );
}
