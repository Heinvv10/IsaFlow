/**
 * The VAT201-vs-GL recon table, plus the four "plain table" exception
 * sections (uncoded GL lines, VAT on a balance-sheet account, invoice
 * tax-code issues, invoice/GL mismatches). Split out of
 * VAT201ExceptionsPanel.tsx (item 11, file-size limit) — no behaviour
 * change, identical markup to what the panel inlined before.
 */
import type { VatExceptionsReport } from '@/modules/accounting/services/reports/vatExceptionsTypes';
import { Section, VarianceCell, fmt, tdNum, td, th } from './vatExceptionsUi';
import { formatSaDateValue } from '@/lib/saDateParser';

export function VatReconTable({ recon }: { recon: VatExceptionsReport['controlRecon'] }) {
  return (
    <div className="px-4 pb-3">
      <p className="text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider mb-2">
        VAT201 vs GL VAT control account
      </p>
      <table className="min-w-[28rem]">
        <thead>
          <tr>
            <th className={th}></th>
            <th className={`${th} text-right`}>VAT201</th>
            <th className={`${th} text-right`}>GL control</th>
            <th className={`${th} text-right`}>Variance</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className={td}>Output VAT</td>
            <td className={tdNum}>{fmt(recon.outputVat201)}</td>
            <td className={tdNum}>{fmt(recon.outputGl)}</td>
            <VarianceCell value={recon.outputVariance} />
          </tr>
          <tr>
            <td className={td}>Input VAT</td>
            <td className={tdNum}>{fmt(recon.inputVat201)}</td>
            <td className={tdNum}>{fmt(recon.inputGl)}</td>
            <VarianceCell value={recon.inputVariance} />
          </tr>
          <tr className="border-t border-[var(--ff-border-light)]">
            <td className={`${td} font-semibold`}>Net VAT</td>
            <td className={`${tdNum} font-semibold`}>{fmt(recon.netVat201)}</td>
            <td className={`${tdNum} font-semibold`}>{fmt(recon.netGl)}</td>
            <VarianceCell value={recon.netVariance} />
          </tr>
        </tbody>
      </table>
      {(recon.unpostedCustomerCount > 0 || recon.unpostedSupplierCount > 0) && (
        <p className="mt-2 text-xs text-[var(--ff-text-tertiary)]">
          Not yet posted to GL: {recon.unpostedCustomerCount} customer invoice{recon.unpostedCustomerCount === 1 ? '' : 's'} ({fmt(recon.unpostedCustomerVat)} VAT),{' '}
          {recon.unpostedSupplierCount} supplier invoice{recon.unpostedSupplierCount === 1 ? '' : 's'} ({fmt(recon.unpostedSupplierVat)} VAT) — in neither column above; listed below, and they block filing.
        </p>
      )}
    </div>
  );
}

/** The first two exception sections, rendered right after the recon table. */
export function VatUncodedAndBalanceSheetSections({ report }: { report: VatExceptionsReport }) {
  return (
    <>
      <Section title="Uncoded GL VAT lines (no VAT type)" count={report.uncodedGlLineCount} listed={report.uncodedGlLines.length}>
        <table className="min-w-full">
          <thead><tr>
            <th className={th}>Entry</th><th className={th}>Date</th><th className={th}>Account</th>
            <th className={th}>Description</th><th className={`${th} text-right`}>Amount</th>
          </tr></thead>
          <tbody>
            {report.uncodedGlLines.map((l, i) => (
              <tr key={`${l.journalEntryId}-${i}`}>
                <td className={td}>{l.entryNumber}</td>
                <td className={td}>{formatSaDateValue(l.entryDate)}</td>
                <td className={td}>{l.accountCode} {l.accountName}</td>
                <td className={`${td} max-w-[16rem] truncate`}>{l.description}</td>
                <td className={tdNum}>{fmt(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title="VAT claimed against a balance-sheet account"
        count={report.vatOnBalanceSheetCount}
        listed={report.vatOnBalanceSheetLines.length}
      >
        <p className={`${td} !border-0 text-slate-500`}>
          VAT belongs to a supply, so the contra leg is normally an income or expense
          account. These lines claim VAT against the balance sheet. Capital goods,
          trading stock, prepayments and the VAT control accounts are excluded — they
          carry VAT legitimately — so anything listed here is worth checking before you
          file.
        </p>
        <table className="min-w-full">
          <thead><tr>
            <th className={th}>Entry</th><th className={th}>Date</th><th className={th}>Account</th>
            <th className={th}>Type</th><th className={th}>VAT type</th>
            <th className={th}>Description</th><th className={`${th} text-right`}>Amount</th>
          </tr></thead>
          <tbody>
            {report.vatOnBalanceSheetLines.map((l, i) => (
              <tr key={`${l.journalEntryId}-${i}`}>
                <td className={td}>{l.entryNumber}</td>
                <td className={td}>{formatSaDateValue(l.entryDate)}</td>
                <td className={td}>{l.accountCode} {l.accountName}</td>
                <td className={td}>{l.accountSubtype ?? l.accountType}</td>
                <td className={td}>{l.vatType}</td>
                <td className={`${td} max-w-[16rem] truncate`}>{l.description}</td>
                <td className={tdNum}>{fmt(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}

/**
 * NOT blocking (Hein, 2026-09-27): supplier bills with no tax rate, or a
 * rate but zero VAT, can only mean less input VAT was claimed than the
 * bill's own rate supports, never more — so unlike the customer-invoice
 * section above, this cannot put the return wrong in SARS's favour against
 * the vendor. Styled like the other non-blocking sections (e.g. "no tax
 * invoice on file").
 */
export function VatBillTaxCodeWarningSection({ report }: {
  report: Pick<VatExceptionsReport, 'billTaxCodeWarnings' | 'billTaxCodeWarningCount' | 'billTaxCodeWarningPotentialVat'>;
}) {
  return (
    <Section
      title="Supplier bills with a VAT rate but no VAT — possible unclaimed input VAT (not blocking)"
      count={report.billTaxCodeWarningCount}
      listed={report.billTaxCodeWarnings.length}
    >
      <p className={`${td} !border-0 text-slate-500 whitespace-normal`}>
        These bills carry no tax code, or a tax rate with zero VAT recorded — a record problem
        that can only mean LESS input VAT was claimed than the bill&apos;s own rate would support,
        never more, so it does not block filing. Potential input VAT at the bill&apos;s rate:{' '}
        <span className="font-semibold">{fmt(report.billTaxCodeWarningPotentialVat)}</span>.
        If the supplier is a VAT vendor this input VAT can still be claimed (a late claim);
        otherwise, correct the rate to zero-rated or exempt.
      </p>
      <table className="min-w-full">
        <thead><tr>
          <th className={th}>Bill</th><th className={th}>Supplier</th>
          <th className={th}>Date</th><th className={th}>Issue</th>
          <th className={`${th} text-right`}>Subtotal</th><th className={`${th} text-right`}>Potential input VAT</th>
        </tr></thead>
        <tbody>
          {report.billTaxCodeWarnings.map((b, i) => (
            <tr key={`${b.invoiceId}-${i}`}>
              <td className={td}>{b.invoiceNumber}</td>
              <td className={td}>{b.counterpartyName}</td>
              <td className={td}>{formatSaDateValue(b.invoiceDate)}</td>
              <td className={`${td} text-amber-400`}>
                {b.issue === 'missing_tax_rate' ? 'No tax code' : 'Tax code set, zero VAT'}
              </td>
              <td className={tdNum}>{fmt(b.subtotal)}</td>
              <td className={tdNum}>{fmt(b.potentialInputVat)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/** The two invoice-issue sections, rendered last — after input-support. */
export function VatInvoiceIssueSections({ report }: { report: VatExceptionsReport }) {
  return (
    <>
      <Section title="Customer invoices with tax-code issues" count={report.invoiceTaxCodeIssueCount} listed={report.invoiceTaxCodeIssues.length}>
        <table className="min-w-full">
          <thead><tr>
            <th className={th}>Invoice</th><th className={th}>Counterparty</th>
            <th className={th}>Date</th><th className={th}>Issue</th><th className={`${th} text-right`}>Subtotal</th>
          </tr></thead>
          <tbody>
            {report.invoiceTaxCodeIssues.map((inv, i) => (
              <tr key={`${inv.invoiceId}-${i}`}>
                <td className={td}>{inv.invoiceNumber}</td>
                <td className={td}>{inv.counterpartyName}</td>
                <td className={td}>{formatSaDateValue(inv.invoiceDate)}</td>
                <td className={`${td} text-amber-400`}>
                  {inv.issue === 'missing_tax_rate' ? 'No tax code' : 'Tax code set, zero VAT'}
                </td>
                <td className={tdNum}>{fmt(inv.subtotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Invoice vs GL VAT mismatches" count={report.invoiceGlMismatchCount} listed={report.invoiceGlMismatches.length}>
        <table className="min-w-full">
          <thead><tr>
            <th className={th}>Invoice</th><th className={th}>Type</th><th className={th}>Counterparty</th>
            <th className={`${th} text-right`}>Invoice VAT</th><th className={`${th} text-right`}>GL VAT</th>
            <th className={`${th} text-right`}>Variance</th>
          </tr></thead>
          <tbody>
            {report.invoiceGlMismatches.map((m, i) => (
              <tr key={`${m.invoiceId}-${i}`}>
                <td className={td}>{m.invoiceNumber}</td>
                <td className={td}>{m.invoiceKind}</td>
                <td className={td}>{m.counterpartyName}</td>
                <td className={tdNum}>{fmt(m.invoiceVat)}</td>
                {m.reason === 'je_not_posted' ? (
                  <td className={`${td} text-right text-amber-400 font-semibold`} colSpan={2}>
                    JE not posted
                  </td>
                ) : (
                  <>
                    <td className={tdNum}>{fmt(m.glVat)}</td>
                    <VarianceCell value={m.variance} />
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}
