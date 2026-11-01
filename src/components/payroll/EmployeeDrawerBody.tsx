/**
 * The employee drawer on /payroll/employees: who they are and what they are paid, without leaving the list.
 * The server decides what a role sees. GET /api/payroll/employees/[id] answers names only for a role that may not see
 * personal data, so pay is not even requested; a 403 on it (a role changed mid-session) reads the same way.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { todayInSast } from '@/lib/saDateParser';
import { Money } from '@/components/ui/Money';
import { formatDisplayDate } from '@/utils/dateFormat';
import type { Assignment } from './EmployeeComponentsCard';

interface Employee {
  employeeNumber: string;
  employmentType: string;
  startDate?: string; // absent when the server answered names only
  endDate?: string;
  taxNumber?: string;
}

interface Loaded {
  employee: Employee;
  /** Null: this role may not see pay. */
  pay: Assignment[] | null;
}

async function loadEmployee(employeeId: string): Promise<Loaded> {
  const res = await apiFetch(`/api/payroll/employees/${employeeId}`);
  await assertOk(res, 'Could not load the employee - try again');
  const json = await res.json();
  const employee = (json.data ?? json) as Employee;
  if (!employee.startDate) return { employee, pay: null };
  const payRes = await apiFetch(`/api/payroll/employees/${employeeId}/components`);
  if (payRes.status === 403) return { employee, pay: null };
  await assertOk(payRes, 'Could not load their pay - try again');
  const payJson = await payRes.json();
  return { employee, pay: (payJson.data ?? payJson) as Assignment[] };
}

const stillRuns = (a: Assignment, today: string) => !a.effectiveTo || String(a.effectiveTo).slice(0, 10) >= today;

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <dt className="text-[var(--ff-text-secondary)]">{label}</dt>
      <dd className="text-[var(--ff-text-primary)]">{value}</dd>
    </div>
  );
}

export function EmployeeDrawerBody({ employeeId }: { employeeId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stale = false;
    loadEmployee(employeeId).then(
      (data) => { if (!stale) setLoaded(data); },
      (err: unknown) => { if (!stale) setError(apiErrorMessage(err, 'Could not load the employee - try again')); },
    );
    return () => { stale = true; };
  }, [employeeId]);

  // Not on mount: Drawer records what to give focus back to in its own effect, which runs after this one would.
  const settled = loaded !== null || error !== '';
  useEffect(() => { if (settled) body.current?.focus(); }, [settled]);

  const today = todayInSast();
  const pay = loaded?.pay?.filter(a => stillRuns(a, today));

  return (
    <div ref={body} tabIndex={-1} className="space-y-6 outline-none">
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!settled && <p className="text-sm text-[var(--ff-text-secondary)]">Loading…</p>}
      {loaded && (
        <>
          <dl>
            <Fact label="Employee number" value={loaded.employee.employeeNumber} />
            <Fact label="Employment type" value={`${loaded.employee.employmentType.charAt(0).toUpperCase()}${loaded.employee.employmentType.slice(1)}`} />
            {loaded.employee.startDate && <Fact label="Start date" value={formatDisplayDate(loaded.employee.startDate)} />}
            {loaded.employee.endDate && <Fact label="End date" value={formatDisplayDate(loaded.employee.endDate)} />}
            {loaded.employee.taxNumber && <Fact label="Tax number" value={loaded.employee.taxNumber} />}
          </dl>
          <section aria-label="Pay">
            <h3 className="mb-2 text-sm font-semibold text-[var(--ff-text-primary)]">Pay</h3>
            {pay === undefined ? (
              <p className="text-sm text-[var(--ff-text-secondary)]">Pay details hidden for your role</p>
            ) : pay.length === 0 ? (
              <p className="text-sm text-[var(--ff-text-secondary)]">No pay components yet.</p>
            ) : (
              <ul className="space-y-2">
                {pay.map(a => (
                  <li key={a.id} className="flex items-baseline justify-between gap-4 text-sm">
                    <span className="text-[var(--ff-text-primary)]">
                      {a.componentName}
                      <span className="ml-2 text-xs text-[var(--ff-text-secondary)]">
                        {a.isRecurring ? 'Recurring' : 'Once-off'}, from {formatDisplayDate(a.effectiveFrom)}
                      </span>
                    </span>
                    <Money amount={a.amount} />
                  </li>
                ))}
              </ul>
            )}
          </section>
          <Link href={`/payroll/employees/${employeeId}`} className="inline-block text-sm font-medium text-teal-700 underline dark:text-teal-400">
            Open full profile
          </Link>
        </>
      )}
    </div>
  );
}
