/**
 * PayrollRunWarnings — a run's validation warnings, one group per warning code
 * (PAY-08). The engine's messages carry the employee's name, so de-duplicating
 * by message merged nothing; grouping by code does, and naming the employee
 * from the run line means a message that omits the name (zero PAYE) still
 * says who it is about.
 */
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';

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

/** The group heading per code. An unknown code falls back to its first message. */
const GROUP_LABEL: Record<string, string> = {
  ETI_INDETERMINATE: 'ETI eligibility could not be determined — no ETI claimed',
  ETI_TABLE_UNCONFIRMED: 'ETI claimed on a table that is unconfirmed for pay periods after 31 March 2026 — verify before submitting',
  PAYE_ZERO_ON_TAXABLE_INCOME: 'Taxable income above the threshold but zero PAYE — verify tax number and directive',
  MISSING_TAX_NUMBER: 'No SARS tax number — PAYE cannot be calculated',
  INVALID_TAX_NUMBER_FORMAT: 'Tax number invalid — must be 10 digits',
  DUPLICATE_TAX_NUMBER: 'Tax number already used by another employee',
  INVALID_ID_NUMBER: 'ID number must be 13 digits',
  MISSING_BANK_DETAILS: 'No bank details — EFT payment will fail',
  DEDUCTIONS_EXCEED_PAY: 'Deductions and tax exceed pay — reduce the deductions, then recalculate',
  LOAN_INSTALMENT_EXCEEDS_PAY: 'Loan instalment exceeds pay — net pay is nil and the deductions payable are understated',
  LOAN_DEDUCTION_MISSING: 'Loan instalment not taken — no active LOAN deduction; add it under Setup → Pay Components, then recalculate',
  LOAN_FRINGE_NOT_RECORDED: 'Loan fringe benefit not recorded — no active 3801 earning; the instalment was taken',
};

/** Codes whose message carries the employee's own figures (a loan, an amount): shown per employee. */
const OWN_FIGURES: ReadonlySet<string> = new Set(['DEDUCTIONS_EXCEED_PAY', 'LOAN_INSTALMENT_EXCEEDS_PAY', 'LOAN_DEDUCTION_MISSING', 'LOAN_FRINGE_NOT_RECORDED']);

/** Line results the approval gate refuses on (payrollLineBlockers): blocking, not warnings. */
const BLOCKING: ReadonlySet<string> = new Set(['DEDUCTIONS_EXCEED_PAY', 'LOAN_DEDUCTION_MISSING']);

interface Group {
  code: string;
  label: string;
  blocking: boolean;
  /** Each employee's own message differs (their loan, their amounts): shown per employee, not as one heading. */
  perEmployee: boolean;
  employees: Array<{ id: string; name: string; href: string; message: string }>;
}

function groupRunWarnings(lines: WarningLine[]): Group[] {
  const groups = new Map<string, Group>();
  for (const line of lines) {
    for (const w of line.validationResults ?? []) {
      let g = groups.get(w.code);
      if (!g) {
        g = { code: w.code, label: GROUP_LABEL[w.code] ?? '', blocking: BLOCKING.has(w.code), perEmployee: false, employees: [] };
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
    // A labelled code whose messages only name the employee stays one line of names (PAY-08).
    g.perEmployee = new Set(g.employees.map((e) => e.message)).size > 1 && (OWN_FIGURES.has(g.code) || !GROUP_LABEL[g.code]);
    // An unknown code: its message only when it is everyone's; otherwise the code, never one employee's words.
    g.label ||= g.perEmployee ? `Other (${g.code})` : g.employees[0]!.message;
  }
  return [...groups.values()].sort((a, b) => Number(b.blocking) - Number(a.blocking));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function PayrollRunWarnings({ lines }: { lines: WarningLine[] }) {
  const groups = groupRunWarnings(lines);
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
                  <li key={`${e.id}-${i}`}><Link href={e.href} className="underline decoration-dotted">{e.name}</Link>: {e.message}</li>
                ))}
              </ul>
            ) : g.employees.map((e, i) => (
              <span key={`${e.id}-${i}`}>
                {i > 0 && ', '}
                <Link href={e.href} title={e.message} className="hover:text-amber-300 underline decoration-dotted">{e.name}</Link>
              </span>
            ))}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-[var(--ff-text-tertiary)]">
        {blocked > 0
          ? `The issues marked "Blocks approval" must be resolved before this run can be approved.${warned > 0 ? ' The warnings do not block it.' : ''}`
          : 'These do not block the run — payroll can still be approved and paid.'}
      </p>
    </section>
  );
}
