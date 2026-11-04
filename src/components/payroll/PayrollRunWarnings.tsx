/**
 * PayrollRunWarnings — a run's validation warnings, one group per warning code
 * (PAY-08). The engine's messages carry the employee's name, so de-duplicating
 * by message merged nothing; grouping by code does, and naming the employee
 * from the run line means a message that omits the name (zero PAYE) still
 * says who it is about.
 */
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { isLocked } from '@/components/payroll/PayrollRunStatusBadge';
import { BLOCKING_LINE_CODES, GROUP_LABEL, OWN_FIGURES } from '@/components/payroll/runWarningCodes';

export interface RunLineWarning {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  field?: string;
  deepLink?: string;
}

interface WarningLine {
  employeeId: string;
  employeeName: string;
  validationResults?: RunLineWarning[];
}

interface Group {
  code: string;
  label: string;
  blocking: boolean;
  /** Each employee's own message differs (their loan, their amounts): shown per employee, not as one heading. */
  perEmployee: boolean;
  employees: Array<{ id: string; name: string; href: string; message: string }>;
}

function groupRunWarnings(lines: WarningLine[], canBlock: boolean): Group[] {
  const groups = new Map<string, Group>();
  for (const line of lines) {
    for (const w of line.validationResults ?? []) {
      let g = groups.get(w.code);
      if (!g) {
        g = { code: w.code, label: GROUP_LABEL[w.code] ?? '', blocking: canBlock && BLOCKING_LINE_CODES.has(w.code), perEmployee: false, employees: [] };
        groups.set(w.code, g);
      }
      g.employees.push({
        id: line.employeeId,
        name: line.employeeName,
        href: w.deepLink ?? `/payroll/employees/${line.employeeId}`,
        message: w.message,
      });
    }
  }
  for (const g of groups.values()) {
    // A code carrying the employee's own figures, or an unlabelled one, always shows each employee's own
    // message, even for one employee: a tooltip is out of reach by keyboard and touch. A labelled code whose
    // messages only name the employee stays one line of names (PAY-08).
    g.perEmployee = OWN_FIGURES.has(g.code) || !GROUP_LABEL[g.code];
    // An unknown code: its message only when it is everyone's; otherwise the code, never one employee's words.
    g.label ||= `Other (${g.code})`;
  }
  return [...groups.values()].sort((a, b) => Number(b.blocking) - Number(a.blocking));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const LINK = 'underline decoration-dotted hover:text-amber-800 dark:hover:text-amber-300';

/** `status`: on an approved, paid or cancelled run nothing is worded as blocking approval. */
export function PayrollRunWarnings({ lines, status }: { lines: WarningLine[]; status?: string }) {
  const groups = groupRunWarnings(lines, !status || !isLocked(status));
  if (groups.length === 0) return null;
  const count = (blocking: boolean) => groups.filter((g) => g.blocking === blocking).reduce((n, g) => n + g.employees.length, 0);
  const [blocked, warned] = [count(true), count(false)];
  const heading = blocked > 0
    ? [plural(blocked, 'issue blocks approval', 'issues block approval'), ...(warned > 0 ? [plural(warned, 'warning', 'warnings')] : [])].join(' · ')
    : `${plural(warned, 'warning', 'warnings')} on this run`;
  return (
    <section className={`rounded-lg border p-4 ${blocked > 0 ? 'border-red-500/40 bg-red-500/5' : 'border-amber-500/40 bg-amber-500/5'}`}>
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className={`h-4 w-4 ${blocked > 0 ? 'text-red-500' : 'text-amber-400'}`} />
        <h2 className={`text-sm font-semibold ${blocked > 0 ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'}`}>{heading}</h2>
      </div>
      <ul className="space-y-2">
        {groups.map((g) => (
          <li key={g.code} className="text-xs text-[var(--ff-text-secondary)]">
            <span className="font-medium text-[var(--ff-text-primary)]">{g.blocking ? 'Blocks approval: ' : ''}{g.label}</span>
            {' — '}{plural(g.employees.length, 'employee', 'employees')}{g.perEmployee ? '' : ': '}
            {g.perEmployee ? (
              <ul className="mt-1 ml-4 list-disc space-y-1">
                {g.employees.map((e, i) => (
                  <li key={`${e.id}-${i}`}><Link href={e.href} className={LINK}>{e.name}</Link>: {e.message}</li>
                ))}
              </ul>
            ) : g.employees.map((e, i) => (
              <span key={`${e.id}-${i}`}>
                {i > 0 && ', '}
                <Link href={e.href} className={LINK}>{e.name}</Link>
              </span>
            ))}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-[var(--ff-text-tertiary)]">
        {blocked > 0
          ? `The issues marked "Blocks approval" must be resolved before this run can be approved.${warned > 0 ? ' The warnings do not block it.' : ''}`
          : status && isLocked(status) ? 'Recorded when this run was calculated.' : 'These warnings do not block approval themselves.'}
      </p>
    </section>
  );
}
