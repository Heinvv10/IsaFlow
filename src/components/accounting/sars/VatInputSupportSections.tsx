/**
 * The two input-VAT support sections of the pre-filing exceptions panel
 * (reports/vatInputSupport.ts):
 *
 *   - "Input VAT with nothing behind it" — BLOCKING. A claim linked to no
 *     document, or one that disagrees with the document it is linked to.
 *   - "Input VAT with no tax invoice on file" — NOT blocking (Hein,
 *     2026-09-25). Supported by a bank line or an approved VAT adjustment:
 *     the money moved, but the tax invoice should be attached.
 *
 * Split out of VAT201ExceptionsPanel for the 300-line file limit; the panel
 * passes its collapsible <Section> shell in so both look the same.
 */
import type { ReactNode } from 'react';
import type { InputVatSupportLine, VatExceptionsReport } from '@/modules/accounting/services/reports/vatExceptionsTypes';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const th = 'px-2 py-1.5 text-left text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider';
const td = 'px-2 py-1.5 text-xs text-[var(--ff-text-primary)] whitespace-nowrap';
const tdNum = `${td} text-right tabular-nums`;

type SectionShell = (props: { title: string; count: number; listed: number; children: ReactNode }) => ReactNode;

const SUPPORT_LABEL: Record<InputVatSupportLine['supportKind'], string> = {
  expense_claim: 'Expense claim',
  captured_document: 'Captured document',
  credit_note: 'Credit note',
  vat_adjustment: 'VAT adjustment',
  bank: 'Bank line only',
  none: 'Nothing',
};

const REASON_LABEL: Record<InputVatSupportLine['reason'], string> = {
  no_document: 'No document linked',
  amount_mismatch: 'Differs from its document',
  no_tax_invoice: 'No tax invoice on file',
};

function SupportTable({ lines }: { lines: InputVatSupportLine[] }) {
  return (
    <table className="min-w-full">
      <thead><tr>
        <th className={th}>Entry</th><th className={th}>Date</th><th className={th}>Supported by</th>
        <th className={th}>Finding</th><th className={th}>Description</th>
        <th className={`${th} text-right`}>VAT claimed</th><th className={`${th} text-right`}>Document VAT</th>
      </tr></thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.journalEntryId}>
            <td className={td}>{l.entryNumber}</td>
            <td className={td}>{l.entryDate}</td>
            <td className={td}>{SUPPORT_LABEL[l.supportKind]}</td>
            <td className={`${td} text-amber-400`}>{REASON_LABEL[l.reason]}</td>
            <td className={`${td} max-w-[16rem] truncate`}>{l.description}</td>
            <td className={tdNum}>{fmt(l.claimedVat)}</td>
            <td className={tdNum}>{l.documentVat === null ? '—' : fmt(l.documentVat)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function VatInputSupportSections({ report, Section }: {
  report: Pick<VatExceptionsReport, 'unsupportedInputVat' | 'unsupportedInputVatCount'
    | 'inputVatWithoutTaxInvoice' | 'inputVatWithoutTaxInvoiceCount'>;
  Section: SectionShell;
}) {
  return (
    <>
      <Section title="Input VAT with nothing behind it" count={report.unsupportedInputVatCount}
        listed={report.unsupportedInputVat.length}>
        <p className={`${td} !border-0 text-slate-500 whitespace-normal`}>
          Every input-VAT claim needs a document behind it. These journals claim input VAT that
          is linked to no bill, expense claim, captured receipt, credit note or bank line, or
          that differs from the document they are linked to. They block filing: attach or post
          the document, or reverse the claim.
        </p>
        <SupportTable lines={report.unsupportedInputVat} />
      </Section>
      <Section title="Input VAT with no tax invoice on file (not blocking)" count={report.inputVatWithoutTaxInvoiceCount}
        listed={report.inputVatWithoutTaxInvoice.length}>
        <p className={`${td} !border-0 text-slate-500 whitespace-normal`}>
          These claims are supported by the bank line (or an approved VAT adjustment), so the
          money moved — but no tax invoice is attached. They do not block filing; attach the tax
          invoice so the deduction can be substantiated.
        </p>
        <SupportTable lines={report.inputVatWithoutTaxInvoice} />
      </Section>
    </>
  );
}
