/**
 * What is behind one EMP201 total: the runs it sums (header total beside its lines), the employee lines (paged, each run
 * linked to its pay run) and any SARS directive payments. Payroll detail: the route refuses non-payroll roles and a
 * platform admin's Login-as, and its refusal is shown in its own words.
 */
import Link from 'next/link';
import { Drawer } from '@/components/ui/Drawer';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDate } from '@/utils/formatters';
import type { Emp201DrillResult } from '@/modules/accounting/services/reports/emp201FieldDrill';
import { DrillFailureNote } from './DrillFailureNote';
import { DrillPager } from './DrillPager';
import { fetchEmp201Drill } from './returnDrillClient';
import { useDrillPages } from './useDrillPages';

export const EMP201_DRILL_LABELS: Record<string, string> = {
  paye: 'PAYE', eti: 'ETI for the period', uif: 'Total UIF', sdl: 'SDL', remuneration: 'Total taxable remuneration',
};

interface Props { field: string | null; from: string; to: string; onClose: () => void }

const month = (y: number, m: number): string => `${y}-${String(m).padStart(2, '0')}`;

function Runs({ r }: { r: Emp201DrillResult }) {
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Pay runs behind this total">
      <table className="w-full min-w-[330px] text-xs" data-testid="emp201-drill-runs">
        <thead><tr className="text-left text-[var(--ff-text-secondary)]">
          <th scope="col" className="py-1 pr-2 font-medium">Pay run</th>
          <th scope="col" className="py-1 pr-2 text-right font-medium">Run total</th>
          <th scope="col" className="py-1 pr-2 text-right font-medium">Its lines</th>
          <th scope="col" className="py-1 text-right font-medium">Difference</th>
        </tr></thead>
        <tbody>
          {r.runs.map((run) => (
            <tr key={run.runId} className="border-t border-[var(--ff-border-light)] text-[var(--ff-text-primary)]">
              <td className="whitespace-nowrap py-1 pr-2">
                <Link href={`/payroll/runs/${run.runId}`} className="inline-flex min-h-[24px] items-center text-teal-700 underline dark:text-teal-400">
                  {month(run.periodYear, run.periodMonth)}
                </Link> <span className="text-[var(--ff-text-secondary)]">{run.status}</span>
              </td>
              <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">{formatMoney(run.headerTotal)}</td>
              <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">{formatMoney(run.linesTotal)}</td>
              <td className="whitespace-nowrap py-1 text-right tabular-nums">{formatMoney(run.difference)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Lines({ r }: { r: Emp201DrillResult }) {
  return (
    <div>
      {r.rows.length > 0 && <p className="mb-1 text-xs text-[var(--ff-text-secondary)] sm:hidden">Scroll sideways for every column.</p>}
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Employee lines behind this total">
        <table className="w-full min-w-[330px] text-xs" data-testid="return-drill-lines">
          <thead><tr className="text-left text-[var(--ff-text-secondary)]">
            <th scope="col" className="py-1 pr-2 font-medium">Employee</th>
            <th scope="col" className="py-1 pr-2 font-medium">Pay run</th>
            <th scope="col" className="py-1 text-right font-medium">Amount</th>
          </tr></thead>
          <tbody>
            {r.rows.map((row) => (
              <tr key={`${row.runId}|${row.employeeId}`} className="border-t border-[var(--ff-border-light)] text-[var(--ff-text-primary)]">
                <td className="py-1 pr-2">{row.employeeNumber} {row.employeeName}</td>
                <td className="whitespace-nowrap py-1 pr-2">
                  <Link href={`/payroll/runs/${row.runId}`} className="inline-flex min-h-[24px] items-center text-teal-700 underline dark:text-teal-400">
                    {month(row.periodYear, row.periodMonth)}
                  </Link>
                </td>
                <td className="whitespace-nowrap py-1 text-right tabular-nums">{formatMoney(row.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.rows.length === 0 && <p className="py-2 text-xs text-[var(--ff-text-secondary)]">No employee lines in this period.</p>}
    </div>
  );
}

function Directives({ r }: { r: Emp201DrillResult }) {
  if (r.directivePayments.length === 0) return null;
  return (
    <section aria-label="SARS directive payments" className="space-y-1">
      <h3 className="text-xs font-semibold text-[var(--ff-text-primary)]">SARS directive payments (outside payroll)</h3>
      <ul className="space-y-0.5 text-xs text-[var(--ff-text-primary)]">
        {r.directivePayments.map((d) => (
          <li key={d.paymentId} className="flex justify-between gap-2">
            <span>{d.employeeName}, directive {d.directiveNumber ?? 'none'}, {formatDate(d.paymentDate)}</span>
            <span data-testid="emp201-drill-directive-amount" className="tabular-nums">{formatMoney(d.amount)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Emp201DrillDrawer({ field, from, to, onClose }: Props) {
  const drill = useDrillPages<Emp201DrillResult>(field !== null, `${field}|${from}|${to}`,
    (page, signal) => fetchEmp201Drill(field as string, from, to, page, signal));
  const { result: r, failure, loading, page, paged } = drill;
  const label = field ? EMP201_DRILL_LABELS[field] ?? field : '';
  return (
    <Drawer open={field !== null} onClose={onClose} title={label} width="lg">
      <div className="space-y-3" data-testid="emp201-drill-drawer" aria-busy={loading}>
        {failure && <DrillFailureNote failure={failure} onRetry={drill.retry} />}
        {loading && <p role="status" className="text-sm text-[var(--ff-text-secondary)]">Loading…</p>}
        {r && (
          <>
            <p className="text-sm text-[var(--ff-text-secondary)]">EMP201 amount <strong data-testid="emp201-drill-amount" className="text-[var(--ff-text-primary)]">{formatMoney(r.total)}</strong></p>
            <p className="text-xs text-[var(--ff-text-secondary)]" data-testid="return-drill-total">
              The pay runs&apos; lines{r.directivePayments.length > 0 ? ' and directive payments' : ''} add up to {formatMoney(r.rowsTotal)}
              {r.ties ? ' — matches the amount.' : ' — does not match: a run’s stored total and its lines disagree (see Difference).'}
            </p>
            <Runs r={r} />
            <Directives r={r} />
            <Lines r={r} />
          </>
        )}
        {(r || failure || (loading && paged)) && (
          <DrillPager page={page} pageSize={r?.pageSize ?? 0} rowCount={r ? r.rowCount : null} hasMore={r ? r.hasMore : null}
            loading={loading} failed={failure !== null} onPage={drill.setPage} />
        )}
      </div>
    </Drawer>
  );
}
