/**
 * Settings -> General: the financial year start month.
 *
 * Read-only once a journal has posted, or for a company other than the active
 * one: PUT /api/accounting/companies refuses a change in both cases
 * (gl/fiscalYearStartChange.ts). When read-only it shows the month the BOOKS use
 * (period 1 of the latest fiscal year), which can differ from the declared
 * month: companies onboarded before 2026-10-22 declare March while their periods
 * run January–December. A difference is always spelled out.
 */
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
      {reason === 'posted' && (
        <p className={NOTE_CLS}>
          Locked because journals have been posted. Changing the financial year end will be possible through a guided
          change of year end (coming soon); contact support if you need it now.
        </p>
      )}
      {mismatch && (
        <p className="text-xs text-amber-400 mt-1">
          {locked
            ? `Your fiscal periods run from ${LONG[actual - 1]}, but the company's declared financial year start is ${LONG[declared - 1]}. Reports follow the periods.`
            : `Your fiscal periods start in ${LONG[actual - 1]}, not in the declared ${LONG[declared - 1]}. Saving rebuilds them on the month selected here if no journals use them yet.`}
        </p>
      )}
    </div>
  );
}
