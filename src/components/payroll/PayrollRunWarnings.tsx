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
  PAYE_ZERO_ON_TAXABLE_INCOME: 'Taxable income above the threshold but zero PAYE — verify tax number and directive',
  MISSING_TAX_NUMBER: 'No SARS tax number — PAYE cannot be calculated',
  INVALID_TAX_NUMBER_FORMAT: 'Tax number invalid — must be 10 digits',
  DUPLICATE_TAX_NUMBER: 'Tax number already used by another employee',
  INVALID_ID_NUMBER: 'ID number must be 13 digits',
  MISSING_BANK_DETAILS: 'No bank details — EFT payment will fail',
};

interface Group {
  code: string;
  label: string;
  employees: Array<{ id: string; name: string; href: string; message: string }>;
}

function groupRunWarnings(lines: WarningLine[]): Group[] {
  const groups = new Map<string, Group>();
  for (const line of lines) {
    for (const w of line.validationResults ?? []) {
      let g = groups.get(w.code);
      if (!g) {
        g = { code: w.code, label: GROUP_LABEL[w.code] ?? w.message, employees: [] };
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
  return [...groups.values()];
}

export function PayrollRunWarnings({ lines }: { lines: WarningLine[] }) {
  const groups = groupRunWarnings(lines);
  if (groups.length === 0) return null;
  const total = groups.reduce((n, g) => n + g.employees.length, 0);
  return (
    <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className="h-4 w-4 text-amber-400" />
        <h2 className="text-sm font-semibold text-amber-300">
          {total} warning{total === 1 ? '' : 's'} on this run
        </h2>
      </div>
      <ul className="space-y-2">
        {groups.map((g) => (
          <li key={g.code} className="text-xs text-[var(--ff-text-secondary)]">
            <span className="font-medium text-[var(--ff-text-primary)]">{g.label}</span>
            {' — '}{g.employees.length} employee{g.employees.length === 1 ? '' : 's'}:{' '}
            {g.employees.map((e, i) => (
              <span key={`${e.id}-${i}`}>
                {i > 0 && ', '}
                <Link href={e.href} title={e.message} className="hover:text-amber-300 underline decoration-dotted">{e.name}</Link>
              </span>
            ))}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-[var(--ff-text-tertiary)]">
        These do not block the run — payroll can still be approved and paid.
      </p>
    </section>
  );
}
