/**
 * What the off-cycle run form chooses from (wave 6 OC): the company's approved regular monthly runs (an off-cycle run
 * supplements one), the employees each kind may pay (bonus: those on the chosen regular run; termination: those whose
 * end date is in its month), and the company's annual-payment earnings (SARS 3605) a bonus is paid on.
 */
import { useEffect, useState } from 'react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';

export interface RegularRunOption { id: string; periodYear: number; periodMonth: number }
export interface PersonOption { employeeId: string; label: string }
export interface ComponentOption { id: string; name: string }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (r: RegularRunOption) => `${MONTHS[r.periodMonth - 1]} ${r.periodYear}`;
export const monthKey = (r: RegularRunOption) => `${r.periodYear}-${String(r.periodMonth).padStart(2, '0')}`;

async function data<T>(url: string, failed: string): Promise<T> {
  const res = await apiFetch(url);
  await assertOk(res, failed);
  const json = await res.json();
  return (json.data ?? json) as T;
}

export function useOffCycleSources() {
  const [runs, setRuns] = useState<RegularRunOption[]>([]);
  const [components, setComponents] = useState<ComponentOption[]>([]);
  const [leavers, setLeavers] = useState<Array<PersonOption & { endDate: string }>>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const all = await data<Array<RegularRunOption & { status: string; runKind?: string; payFrequency?: string }>>('/api/payroll/runs', 'Could not load the payroll runs');
        const comps = await data<Array<{ id: string; name: string; sarsSourceCode: string; componentType: string }>>('/api/payroll/components', 'Could not load the pay components');
        const people = await data<Array<{ id: string; employeeNumber: string; firstName: string; lastName: string; endDate?: string | null }>>(
          '/api/payroll/employees?include=terminated', 'Could not load the employees');
        if (!live) return;
        setRuns(all.filter((r) => r.status === 'approved' && (r.runKind ?? 'regular') === 'regular' && (r.payFrequency ?? 'monthly') === 'monthly'));
        setComponents(comps.filter((c) => c.componentType === 'earning' && c.sarsSourceCode.trim() === '3605').map((c) => ({ id: c.id, name: c.name })));
        setLeavers(people.filter((p) => p.endDate).map((p) => ({
          employeeId: p.id, label: `${p.employeeNumber} ${p.firstName} ${p.lastName}`.trim(), endDate: String(p.endDate).slice(0, 10),
        })));
      } catch (err) {
        if (live) setError(apiErrorMessage(err, 'Could not load what an off-cycle run needs - try again'));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, []);
  return { runs, components, leavers, error, loading };
}

/** The employees on the chosen regular run (a bonus pays only them). */
export function useRunPeople(runId: string | null) {
  const [people, setPeople] = useState<PersonOption[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!runId) { setPeople([]); return; }
    let live = true;
    data<{ lines: Array<{ employeeId: string; employeeNumber: string; employeeName: string }> }>(`/api/payroll/runs/${runId}`, 'Could not load the regular run')
      .then((run) => { if (live) setPeople(run.lines.map((l) => ({ employeeId: l.employeeId, label: `${l.employeeNumber} ${l.employeeName}` }))); })
      .catch((err) => { if (live) setError(apiErrorMessage(err, 'Could not load the regular run - try again')); });
    return () => { live = false; };
  }, [runId]);
  return { people, error };
}
