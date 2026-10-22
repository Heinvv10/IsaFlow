/**
 * EMP201 breakdown: SARS directives paid outside payroll in the period. Their
 * PAYE is already in the EMP201 totals (emp201Service, PAYE 4a follow-ups G1).
 */
import { formatDate } from '@/utils/formatters';

export interface Emp201DirectivePaymentRow {
  paymentId: string;
  directiveNumber: string | null;
  employeeName: string;
  paymentDate: string;
  gross: number;
  paye: number;
}

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

export function Emp201DirectivePayments({ rows }: { rows: Emp201DirectivePaymentRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
      <div className="px-4 py-3 text-sm font-medium text-[var(--ff-text-primary)]">
        Tax directives paid outside payroll ({rows.length}) — included in PAYE above
      </div>
      <table className="w-full text-sm border-t border-[var(--ff-border-light)]">
        <thead>
          <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
            <th className="px-4 py-2">Paid</th>
            <th className="px-4 py-2">Directive</th>
            <th className="px-4 py-2">Employee</th>
            <th className="px-4 py-2 text-right">Gross</th>
            <th className="px-4 py-2 text-right">PAYE</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.paymentId} className="border-b border-[var(--ff-border-light)]">
              <td className="px-4 py-2 text-[var(--ff-text-primary)]">{formatDate(p.paymentDate)}</td>
              <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{p.directiveNumber ?? '—'}</td>
              <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{p.employeeName}</td>
              <td className="px-4 py-2 text-right text-[var(--ff-text-primary)]">{fmt(p.gross)}</td>
              <td className="px-4 py-2 text-right text-[var(--ff-text-secondary)]">{fmt(p.paye)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
