/**
 * The two input-VAT support sections of the pre-filing exceptions panel
 * (reports/vatInputSupport.ts). The cut (Hein, 2026-09-26) is whether the
 * return's FIGURES would be wrong, not whether a document is attached:
 *
 *   - "Input VAT that exceeds its support" — BLOCKING. `amount_mismatch`
 *     (credit note, expense claim, captured document, bank ceiling) or
 *     `document_over_claimed`: the claimed VAT does not tie to what actually
 *     supports it, so the return's figures are wrong. Also `document_unlinked`
 *     (breaker round 2, Hein 2026-09-26): a document WAS linked, evidencing
 *     the claim, and someone removed the link without replacing it or
 *     reversing the claim — different from never having had one.
 *   - "Input VAT with no tax invoice on file" — NOT blocking. Supported only
 *     by a bank line or an approved VAT adjustment (Hein, 2026-09-25); linked
 *     to no document at all, or to one whose VAT couldn't be read (Hein,
 *     2026-09-26). Only a RECORD is missing — holding the tax invoice is the
 *     vendor's legal responsibility, and it may be held outside IsaFlow, so
 *     attaching or linking it here is optional.
 *
 * Split out of VAT201ExceptionsPanel for the 300-line file limit; the panel
 * passes its collapsible <Section> shell in so both look the same.
 */
import type { ReactNode } from 'react';
import type { InputVatSupportLine, VatExceptionsReport } from '@/modules/accounting/services/reports/vatExceptionsTypes';
import { LinkTaxInvoiceButton } from '@/components/accounting/gl/LinkTaxInvoiceButton';

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
  document_over_claimed: 'Document already claimed by another journal',
  document_unlinked: 'Document unlinked — evidence removed',
  unreadable_document_vat: 'Document VAT could not be read',
  no_tax_invoice: 'No tax invoice on file',
};

function SupportTable({ lines, linkable }: { lines: InputVatSupportLine[]; linkable?: boolean }) {
  return (
    <table className="min-w-full">
      <thead><tr>
        <th className={th}>Entry</th><th className={th}>Date</th><th className={th}>Supported by</th>
        <th className={th}>Finding</th><th className={th}>Description</th>
        <th className={`${th} text-right`}>VAT claimed</th><th className={`${th} text-right`}>Document VAT</th>
        {linkable && <th className={th} />}
      </tr></thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.journalEntryId}>
            <td className={td}>{l.entryNumber}</td>
            <td className={td}>{l.entryDate}</td>
            {/* An unlinked chain had a document; "Nothing" would read as never evidenced. */}
            <td className={td}>{l.reason === 'document_unlinked' ? 'Document removed' : SUPPORT_LABEL[l.supportKind]}</td>
            <td className={`${td} text-amber-400`}>{REASON_LABEL[l.reason]}</td>
            <td className={`${td} max-w-[16rem] truncate`}>{l.description}</td>
            <td className={tdNum}>{fmt(l.claimedVat)}</td>
            <td className={tdNum}>{l.documentVat === null ? '—' : fmt(l.documentVat)}</td>
            {linkable && (
              <td className={td}>
                <LinkTaxInvoiceButton journalEntryId={l.journalEntryId} />
              </td>
            )}
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
      <Section title="Input VAT that exceeds its support" count={report.unsupportedInputVatCount}
        listed={report.unsupportedInputVat.length}>
        <p className={`${td} !border-0 text-slate-500 whitespace-normal`}>
          These journals claim more input VAT than the bill, expense claim, captured receipt,
          credit note or bank line they are linked to actually supports — the same document
          twice over — or once had a document linked and no longer do, with nothing else
          supporting the claim. The return&apos;s figures are wrong (or the evidence for them was
          withdrawn) until this is fixed. They block filing: link the correct document, correct
          the claim, or reverse it.
        </p>
        <SupportTable lines={report.unsupportedInputVat} linkable />
      </Section>
      <Section title="Input VAT with no tax invoice on file (not blocking)" count={report.inputVatWithoutTaxInvoiceCount}
        listed={report.inputVatWithoutTaxInvoice.length}>
        <p className={`${td} !border-0 text-slate-500 whitespace-normal`}>
          These claims are supported only by a bank line or an approved VAT adjustment, or are
          linked to no document at all, or to one whose VAT amount couldn&apos;t be read — so the
          money moved but no tax invoice is on file here. Holding a valid tax invoice for this
          input VAT is the vendor&apos;s legal responsibility, and it may be held outside IsaFlow,
          so this does not block filing. Attaching or linking it here is optional. An invoice
          attached to the bank line itself (bank-transactions) also clears a bank-only claim from
          this list.
        </p>
        <SupportTable lines={report.inputVatWithoutTaxInvoice} linkable />
      </Section>
    </>
  );
}
