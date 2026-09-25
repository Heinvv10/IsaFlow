/**
 * "Invoices with VAT not posted to the GL" — BLOCKING (reports/vatUnpostedInvoices.ts).
 * An issued invoice or approved bill whose VAT never reached the GL is in
 * neither the filed return nor the control account, so the recon ties at R0
 * without it. Split out of VAT201ExceptionsPanel for the 300-line limit; the
 * panel passes its <Section> shell in.
 */
import type { ReactNode } from 'react';
import type { VatExceptionsReport } from '@/modules/accounting/services/reports/vatExceptionsTypes';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const th = 'px-2 py-1.5 text-left text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider';
const td = 'px-2 py-1.5 text-xs text-[var(--ff-text-primary)] whitespace-nowrap';
const tdNum = `${td} text-right tabular-nums`;

type SectionShell = (props: { title: string; count: number; listed: number; children: ReactNode }) => ReactNode;

export default function VatUnpostedInvoicesSection({ report, Section }: {
  report: Pick<VatExceptionsReport, 'unpostedInvoiceVat' | 'unpostedInvoiceVatCount' | 'controlRecon'>;
  Section: SectionShell;
}) {
  const { unpostedCustomerVat, unpostedSupplierVat } = report.controlRecon;
  return (
    <Section title="Invoices with VAT not posted to the GL" count={report.unpostedInvoiceVatCount}
      listed={report.unpostedInvoiceVat.length}>
      <p className={`${td} !border-0 text-slate-500 whitespace-normal`}>
        Their VAT is in neither the return nor the VAT control account, so filing now would leave it
        out — output VAT {fmt(unpostedCustomerVat)}, input VAT {fmt(unpostedSupplierVat)}. Post them
        (approve / finalise) before filing.
      </p>
      <table className="min-w-full">
        <thead><tr>
          <th className={th}>Invoice</th><th className={th}>Type</th><th className={th}>Counterparty</th>
          <th className={th}>Date</th><th className={`${th} text-right`}>VAT</th>
        </tr></thead>
        <tbody>
          {report.unpostedInvoiceVat.map((u) => (
            <tr key={`${u.invoiceKind}-${u.invoiceId}`}>
              <td className={td}>{u.invoiceNumber}</td>
              <td className={td}>{u.invoiceKind}</td>
              <td className={td}>{u.counterpartyName}</td>
              <td className={td}>{u.invoiceDate}</td>
              <td className={tdNum}>{fmt(u.vat)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
