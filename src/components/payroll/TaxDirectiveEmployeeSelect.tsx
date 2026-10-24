/**
 * The employee picker of the new-directive form (PAYE 4a follow-ups round 2,
 * R4): the payroll employee a directive is paid to, leavers included
 * (severance, retirement and death directives are for people who have left).
 * Required: a run pays a directive only to its employee, and the stand-alone
 * payment refuses one without.
 */

import { useEffect, useState } from 'react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';

/** What the picker reads from GET /api/payroll/employees (a write role gets the full record). */
export interface PickerEmployee {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  taxNumber?: string | null;
}

const LOAD_FAILED = 'Could not load the employees - try again';

export function useDirectiveEmployees(): { employees: PickerEmployee[]; loading: boolean; error: string; reload: () => void } {
  const [employees, setEmployees] = useState<PickerEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Bumped by reload (the error's Try again): the effect runs the load again.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const res = await apiFetch('/api/payroll/employees?include=terminated');
        await assertOk(res, LOAD_FAILED);
        const json = await res.json();
        if (live) setEmployees(Array.isArray(json.data) ? json.data as PickerEmployee[] : []);
      } catch (err) {
        if (!live) return;
        setEmployees([]);
        setError(apiErrorMessage(err, LOAD_FAILED));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [attempt]);
  return { employees, loading, error, reload: () => setAttempt(n => n + 1) };
}

interface SelectProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  employees: PickerEmployee[];
  loading: boolean;
  error: string;
  inputCls: string;
  labelCls: string;
  onRetry: () => void;
}

export function DirectiveEmployeeSelect({ value, onChange, employees, loading, error, inputCls, labelCls, onRetry }: SelectProps) {
  const status = error || (loading ? 'Loading employees...'
    : employees.length === 0 ? 'No payroll employees yet - add the employee under Payroll > Employees first' : '');
  return (
    <div className="col-span-2">
      <label htmlFor="td-employee" className={labelCls}>Employee *</label>
      <select id="td-employee" className={inputCls} value={value} onChange={onChange} required disabled={loading}>
        <option value="">Select an employee</option>
        {employees.map(emp => (
          <option key={emp.id} value={emp.id}>{`${emp.lastName}, ${emp.firstName} (${emp.employeeNumber})`}</option>
        ))}
      </select>
      {status && <p className={`text-xs mt-1 ${error ? 'text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>{status}</p>}
      {error && (
        <button type="button" onClick={onRetry} className="text-xs mt-1 text-teal-400 hover:text-teal-300">Try again</button>
      )}
    </div>
  );
}
