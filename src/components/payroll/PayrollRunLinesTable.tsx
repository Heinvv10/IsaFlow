/**
 * PayrollRunLinesTable — a run's lines, laid out so Net reconciles on screen
 * (PAY-06): Gross − PAYE − UIF (employee) − Other deductions = Net, with the
 * employer's own contributions in a separate group and a totals footer.
 *
 * "Other deductions" is the residual gross − PAYE − employee UIF − net, the
 * same residual the payroll journal credits to 2175, so the column is the
 * voluntary deductions (medical aid, pension, RA, loans) the calculator took.
 */
import { formatCurrency } from '@/utils/formatters';
import { splitRunTotals } from '@/modules/accounting/services/payroll/payrollRunTotalsSplit';

export interface RunLineAmounts {
  id: string;
  employeeNumber: string;
  employeeName: string;
  grossPay: number;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
  eti: number;
  netPay: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const otherDeductions = (l: RunLineAmounts) => round2(l.grossPay - l.paye - l.uifEmployee - l.netPay);

function sumRunLines(lines: RunLineAmounts[]) {
  const sum = (f: (l: RunLineAmounts) => number) => round2(lines.reduce((s, l) => s + f(l), 0));
  return {
    grossPay: sum((l) => l.grossPay),
    paye: sum((l) => l.paye),
    uifEmployee: sum((l) => l.uifEmployee),
    other: sum(otherDeductions),
    netPay: sum((l) => l.netPay),
    uifEmployer: sum((l) => l.uifEmployer),
    sdl: sum((l) => l.sdl),
    eti: sum((l) => l.eti),
  };
}

interface RunHeaderTotals {
  employeeCount: number;
  totalGross: number;
  totalPaye: number;
  totalUif: number;
  totalSdl: number;
  totalNet: number;
}

/**
 * The run's stat cards — the header's totals, split by the same
 * splitRunTotals the payroll journal books them with, so "Other deductions"
 * is the 2175 credit and the UIF halves are the journal's.
 */
export function PayrollRunTotals({ run }: { run: RunHeaderTotals }) {
  const split = splitRunTotals({ gross: run.totalGross, paye: run.totalPaye, uif: run.totalUif, net: run.totalNet });
  const stats = [
    { label: 'Employees', value: String(run.employeeCount), mono: false, accent: false },
    { label: 'Total Gross', value: formatCurrency(run.totalGross), mono: true, accent: false },
    { label: 'Total PAYE', value: formatCurrency(run.totalPaye), mono: true, accent: false },
    { label: 'UIF (employee)', value: formatCurrency(split.employeeUif), mono: true, accent: false },
    { label: 'Other deductions', value: formatCurrency(split.otherDeductions), mono: true, accent: false },
    { label: 'Total Net', value: formatCurrency(run.totalNet), mono: true, accent: true },
    { label: 'UIF (employer)', value: formatCurrency(split.employerUif), mono: true, accent: false },
    { label: 'Total SDL', value: formatCurrency(run.totalSdl), mono: true, accent: false },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
      {stats.map((stat) => (
        <div key={stat.label} className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-3">
          <p className="text-xs uppercase tracking-wide text-[var(--ff-text-tertiary)]">{stat.label}</p>
          <p className={`mt-1 ${stat.mono ? 'tabular-nums' : ''} ${stat.accent ? 'text-teal-400' : 'text-[var(--ff-text-primary)]'} text-sm font-semibold`}>
            {stat.value}
          </p>
        </div>
      ))}
    </div>
  );
}

const th = 'py-2 px-4 text-[var(--ff-text-secondary)] font-medium';
const num = 'py-2 px-4 text-right tabular-nums';

export function PayrollRunLinesTable({ lines }: { lines: RunLineAmounts[] }) {
  const t = sumRunLines(lines);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="bg-[var(--ff-bg-secondary)] text-xs">
          <th colSpan={3} />
          <th colSpan={3} className={`${th} text-center border-l border-[var(--ff-border-primary)]`}>Employee deductions</th>
          <th className="border-l border-[var(--ff-border-primary)]" />
          <th colSpan={3} className={`${th} text-center border-l border-[var(--ff-border-primary)]`}>Employer contributions</th>
        </tr>
        <tr className="bg-[var(--ff-bg-secondary)] text-left">
          <th className={th}>Emp #</th>
          <th className={th}>Name</th>
          <th className={`${th} text-right`}>Gross</th>
          <th className={`${th} text-right border-l border-[var(--ff-border-primary)]`}>PAYE</th>
          <th className={`${th} text-right`}>UIF</th>
          <th className={`${th} text-right`}>Other</th>
          <th className={`${th} text-right border-l border-[var(--ff-border-primary)]`}>Net</th>
          <th className={`${th} text-right border-l border-[var(--ff-border-primary)]`}>UIF</th>
          <th className={`${th} text-right`}>SDL</th>
          <th className={`${th} text-right`}>ETI</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.id} className="border-t border-[var(--ff-border-primary)]">
            <td className="py-2 px-4 font-mono text-xs text-[var(--ff-text-secondary)]">{l.employeeNumber}</td>
            <td className="py-2 px-4 text-[var(--ff-text-primary)]">{l.employeeName}</td>
            <td className={`${num} text-[var(--ff-text-primary)]`}>{formatCurrency(l.grossPay)}</td>
            <td className={`${num} text-[var(--ff-text-secondary)] border-l border-[var(--ff-border-primary)]`}>{formatCurrency(l.paye)}</td>
            <td className={`${num} text-[var(--ff-text-secondary)]`}>{formatCurrency(l.uifEmployee)}</td>
            <td className={`${num} text-[var(--ff-text-secondary)]`}>{formatCurrency(otherDeductions(l))}</td>
            <td className={`${num} text-teal-400 font-medium border-l border-[var(--ff-border-primary)]`}
              title={`${formatCurrency(l.grossPay)} gross − ${formatCurrency(l.paye)} PAYE − ${formatCurrency(l.uifEmployee)} UIF − ${formatCurrency(otherDeductions(l))} other = ${formatCurrency(l.netPay)} net`}>
              {formatCurrency(l.netPay)}
            </td>
            <td className={`${num} text-[var(--ff-text-secondary)] border-l border-[var(--ff-border-primary)]`}>{formatCurrency(l.uifEmployer)}</td>
            <td className={`${num} text-[var(--ff-text-secondary)]`}>{formatCurrency(l.sdl)}</td>
            <td className={`${num} text-[var(--ff-text-secondary)]`}>{formatCurrency(l.eti)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-[var(--ff-border-primary)] font-semibold text-[var(--ff-text-primary)]">
          <td className="py-2 px-4" colSpan={2}>Totals</td>
          <td className={num}>{formatCurrency(t.grossPay)}</td>
          <td className={`${num} border-l border-[var(--ff-border-primary)]`}>{formatCurrency(t.paye)}</td>
          <td className={num}>{formatCurrency(t.uifEmployee)}</td>
          <td className={num}>{formatCurrency(t.other)}</td>
          <td className={`${num} text-teal-400 border-l border-[var(--ff-border-primary)]`}>{formatCurrency(t.netPay)}</td>
          <td className={`${num} border-l border-[var(--ff-border-primary)]`}>{formatCurrency(t.uifEmployer)}</td>
          <td className={num}>{formatCurrency(t.sdl)}</td>
          <td className={num}>{formatCurrency(t.eti)}</td>
        </tr>
      </tfoot>
    </table>
  );
}
