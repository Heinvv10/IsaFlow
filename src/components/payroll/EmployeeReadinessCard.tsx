/**
 * "Ready to pay" at the head of the employee profile (wave 4 B): one verdict, and for anything missing a link that
 * takes the reader to the field. Silent until the bank read answers, so it never says "ready" too early.
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { loadBankState } from './employeeBankState';
import { employeeReadiness, readinessSummary, type BankState, type ReadinessAssignment } from './employeeReadiness';

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
  field?.focus();
}

export function EmployeeReadinessCard({ employeeId, employee, assignments, refreshKey = 0 }: Props) {
  const [bank, setBank] = useState<BankState | null>(null);
  useEffect(() => {
    let stale = false;
    void loadBankState(employeeId).then(s => { if (!stale) setBank(s); });
    return () => { stale = true; };
  }, [employeeId, refreshKey]);

  if (bank === null) return <p className="text-sm text-[var(--ff-text-secondary)]" role="status">Checking…</p>;
  const result = employeeReadiness({ employee, components: assignments, bank });
  const Icon = result.ready ? CheckCircle2 : AlertTriangle;
  const tone = result.ready
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
    : 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-300';
  return (
    <section role="status" data-testid="employee-readiness-card" className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${tone}`}>
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <div>
        <p className="font-medium">{readinessSummary(result)}</p>
        {!result.ready && (
          <ul className="mt-1 list-inside list-disc">
            {result.missing.map(m => (
              <li key={m.key}><a href={m.href} onClick={e => goTo(e, m.href)} className="underline">{m.label}</a></li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
