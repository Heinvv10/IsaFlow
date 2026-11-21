/**
 * What the off-cycle run form chooses from (wave 6 OC): the company's FINAL regular monthly runs (an off-cycle run
 * supplements one; `final` is the server's payRunIsFinal, approved or paid with an approval time, review #1679 codex 6), the employees each kind may pay (bonus: those on the chosen regular run; termination: those whose
 * end date is in its month), and the company's annual-payment earnings (SARS 3605) a bonus is paid on.
 */
import { useEffect, useState } from 'react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';

export interface RegularRunOption { id: string; periodYear: number; periodMonth: number; runDate?: string | null; periodEnd?: string | null }

/** The last day an off-cycle run of this month may be paid: the day before its regular run's pay date (review #1575 carry 1). */
export function lastOffCyclePayDay(r: RegularRunOption): string {
  const closing = r.runDate ?? r.periodEnd
    ?? `${monthKey(r)}-${String(new Date(r.periodYear, r.periodMonth, 0).getDate()).padStart(2, '0')}`;
  const [y, m, d] = closing.slice(0, 10).split('-').map(Number) as [number, number, number];
  const prev = new Date(y, m - 1, d - 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${String(prev.getDate()).padStart(2, '0')}`;
}
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

/** An existing off-cycle run of a month, as the run list gives it (its pay date and status). */
export interface OffCycleRunOption { periodYear: number; periodMonth: number; runDate?: string | null; status: string }

/**
 * The first day a NEW off-cycle run of `run`'s month may be paid (UI review #1620 L4, as the server's
 * offCycleOrderRefusal judges it): today or later, inside the month, and after every non-cancelled off-cycle run of it.
 */
export function firstOffCyclePayDay(run: RegularRunOption, offCycle: OffCycleRunOption[], today: string): string {
  const monthStart = `${monthKey(run)}-01`;
  const latest = offCycle
    .filter((o) => o.status !== 'cancelled' && o.periodYear === run.periodYear && o.periodMonth === run.periodMonth && o.runDate)
    .map((o) => String(o.runDate).slice(0, 10)).sort().at(-1);
  const after = latest ? (() => {
    const [y, m, d] = latest.split('-').map(Number) as [number, number, number];
    const next = new Date(y, m - 1, d + 1);
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
  })() : monthStart;
  return [today, monthStart, after].sort().at(-1)!;
}

export function useOffCycleSources() {
  const [runs, setRuns] = useState<RegularRunOption[]>([]);
  const [offCycle, setOffCycle] = useState<OffCycleRunOption[]>([]);
  const [components, setComponents] = useState<ComponentOption[]>([]);
  const [leavers, setLeavers] = useState<Array<PersonOption & { endDate: string }>>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const all = await data<Array<RegularRunOption & { status: string; final?: boolean; runKind?: string; payFrequency?: string }>>('/api/payroll/runs', 'Could not load the payroll runs');
        const comps = await data<Array<{ id: string; name: string; sarsSourceCode: string; componentType: string }>>('/api/payroll/components', 'Could not load the pay components');
        const people = await data<Array<{ id: string; employeeNumber: string; firstName: string; lastName: string; endDate?: string | null }>>(
          '/api/payroll/employees?include=terminated', 'Could not load the employees');
        if (!live) return;
        setRuns(all.filter((r) => r.final === true && (r.runKind ?? 'regular') === 'regular' && (r.payFrequency ?? 'monthly') === 'monthly'));
        setOffCycle(all.filter((r) => r.runKind === 'off_cycle'));
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
  return { runs, offCycle, components, leavers, error, loading };
}

/** The employees on the chosen regular run (a bonus pays only them). */
export function useRunPeople(runId: string | null) {
  const [people, setPeople] = useState<PersonOption[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    // A new run: the last run's roster and error go first (review #1679 N8), so a failed lookup never shows them.
    setPeople([]);
    setError('');
    if (!runId) return;
    let live = true;
    data<{ lines: Array<{ employeeId: string; employeeNumber: string; employeeName: string }> }>(`/api/payroll/runs/${runId}`, 'Could not load the regular run')
      .then((run) => { if (live) setPeople(run.lines.map((l) => ({ employeeId: l.employeeId, label: `${l.employeeNumber} ${l.employeeName}` }))); })
      .catch((err) => { if (live) setError(apiErrorMessage(err, 'Could not load the regular run - try again')); });
    return () => { live = false; };
  }, [runId]);
  return { people, error };
}
