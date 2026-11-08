/**
 * "Ready to pay" at the head of the employee profile (wave 4 B): one verdict, and for anything missing a link that
 * takes the reader to the field. Silent until the bank read answers, so it never says "ready" too early.
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { loadBankState, loadHasFinalRun, loadRunMonth } from './employeeBankState';
import { employeeReadiness, readinessSummary, type BankRead, type ReadinessAssignment } from './employeeReadiness';

interface Props {
  employeeId: string;
  employee: { taxNumber?: string | null; paymentMethod?: string | null };
  assignments: ReadinessAssignment[];
  /** Change it after the bank details change to read them again. */
  refreshKey?: number;
}

function goTo(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
  const target = document.getElementById(href.slice(1));
  if (!target) return;
  e.preventDefault();
  target.scrollIntoView?.({ block: 'center' });
  const field = target.matches('input,select,button,textarea') ? target : target.querySelector<HTMLElement>('input,select,button,textarea');
  if (field) { field.focus(); return; }
  // The card has not drawn its field yet (still loading): land on the card itself rather than nowhere.
  target.tabIndex = -1;
  target.focus();
}

export function EmployeeReadinessCard({ employeeId, employee, assignments, refreshKey = 0 }: Props) {
  // Each read lands on its own, so the card shows what it knows (the tax number) at once and fills in the rest.
  const [bank, setBank] = useState<BankRead>('pending');
  const [runMonth, setRunMonth] = useState<string | null>(null);
  const [hasFinalRun, setHasFinalRun] = useState<boolean | null | 'pending'>('pending');
  useEffect(() => {
    let stale = false;
    setBank('pending');
    void loadBankState(employeeId).then(b => { if (!stale) setBank(b); });
    return () => { stale = true; };
  }, [employeeId, refreshKey]);
  useEffect(() => {
    let stale = false;
    setRunMonth(null);
    setHasFinalRun('pending');
    void loadRunMonth().then(m => { if (!stale) setRunMonth(m); });
    void loadHasFinalRun(employeeId).then(f => { if (!stale) setHasFinalRun(f); });
    return () => { stale = true; };
  }, [employeeId]);

  const result = employeeReadiness({ employee, components: assignments, bank, runMonth });
  const checking = !result.ready && result.missing.length === 0;
  const Icon = result.ready ? CheckCircle2 : AlertTriangle;
  const tone = result.ready
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
    : checking ? 'border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)]'
    : 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-300';
  return (
    <section role="status" data-testid="employee-readiness-card" className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${tone}`}>
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <div>
        <p className="font-medium">{readinessSummary(result, hasFinalRun)}</p>
        {!result.ready && !checking && (
          <ul className="mt-1 list-inside list-disc">
            {result.missing.map(m => (
              <li key={m.key}><a href={m.href} onClick={e => goTo(e, m.href)} className="underline">{m.label}</a></li>
            ))}
            {result.pending.map(c => <li key={c} className="list-none text-xs opacity-80">Checking {c}…</li>)}
          </ul>
        )}
      </div>
    </section>
  );
}
