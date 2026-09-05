/**
 * Body of the "VAT where no supply can arise" exception section.
 *
 * Split out of VAT201ExceptionsPanel purely for the 300-line file limit; the
 * panel still owns the collapsible <Section> shell and the counts. The rule
 * itself, and why each category can never carry VAT, lives in
 * vatNonSupplyExceptions.ts.
 */

import type { NonSupplyReason, VatNonSupplyLine } from '@/modules/accounting/services/reports/vatExceptionsTypes';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const th = 'px-2 py-1.5 text-left text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider';
const td = 'px-2 py-1.5 text-xs text-[var(--ff-text-primary)] whitespace-nowrap';
const tdNum = `${td} text-right tabular-nums`;

/** Reader-facing wording for each category, in the reviewer's language. */
export const NON_SUPPLY_REASON_LABEL: Record<NonSupplyReason, string> = {
  employment_cost: 'Employment cost — not a supply',
  tax_or_penalty: 'Tax, fine or penalty — imposed, not supplied',
  distribution: 'Distribution to owners — no consideration',
  depreciation: 'Depreciation — internal allocation, no transaction',
  donation: 'Donation — given without consideration',
  financial_service: 'Exempt financial service',
};

export default function VatNonSupplySection({ lines }: { lines: VatNonSupplyLine[] }) {
  return (
    <>
      <p className={`${td} !border-0 text-slate-500`}>
        VAT arises on a supply. These lines carry a VAT code against an account where
        no supply can happen — salaries and statutory deductions, taxes and penalties,
        distributions, depreciation, donations, and exempt financial services such as
        interest, loans and share investments. Input tax claimed here has nothing to
        substantiate it, and output tax declared here was never due.
      </p>
      <table className="min-w-full">
        <thead><tr>
          <th className={th}>Entry</th><th className={th}>Date</th><th className={th}>Account</th>
          <th className={th}>Why</th><th className={th}>VAT type</th>
          <th className={th}>Description</th><th className={`${th} text-right`}>Amount</th>
        </tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={`${l.journalEntryId}-${i}`}>
              <td className={td}>{l.entryNumber}</td>
              <td className={td}>{l.entryDate}</td>
              <td className={td}>{l.accountCode} {l.accountName}</td>
              <td className={`${td} text-amber-400`}>
                {l.reason ? NON_SUPPLY_REASON_LABEL[l.reason] : '—'}
              </td>
              <td className={td}>{l.vatType}</td>
              <td className={`${td} max-w-[16rem] truncate`}>{l.description}</td>
              <td className={tdNum}>{fmt(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
