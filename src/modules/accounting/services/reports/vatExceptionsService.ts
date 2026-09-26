/**
 * VAT Exceptions Report Service
 * Pre-filing quality checks for the VAT201: uncoded GL VAT lines, invoice
 * tax-code issues, invoice↔GL VAT mismatches, and a cent-level reconciliation
 * of VAT201 box totals against GL VAT control account movement.
 * Informational only — nothing here blocks generation or submission.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getLedgerVAT201 } from './vat201LedgerFields';
import {
  mapMismatch, mapTaxIssue, mapUncodedLine, mapUnpostedInvoice, r2, toNum, totalCount,
} from './vatExceptionsTypes';
import {
  findVatOnBalanceSheetLines,
  mapVatOnBalanceSheetLine,
} from './vatBalanceSheetExceptions';
import { findVatControlMovement } from './vatControlMovement';
import {
  findVatNonSupplyLines,
  mapVatNonSupplyLine,
} from './vatNonSupplyExceptions';
import { findInputVatSupport } from './vatInputSupport';
import { findUnpostedInvoiceVat, findVatDeclaredElsewhere } from './vatUnpostedInvoices';
import { mapDeclaredElsewhere } from './vatExceptionsTypes';
import type { VatControlRecon, VatExceptionsReport } from './vatExceptionsTypes';

export type {
  UncodedGlVatLine, InvoiceTaxCodeIssue, InvoiceGlVatMismatch,
  VatControlRecon, VatExceptionsReport,
} from './vatExceptionsTypes';
import { VAT_SUBMISSION_CLEARING_SOURCE } from './vatSubmissionClearing';

type Row = DbRow;

const LIST_CAP = 100;
const CENT = 0.005;

/**
 * Build the VAT exceptions report for a period.
 * Runs 10 scoped queries (numbered 1-10 below) plus the LEDGER VAT201
 * (getLedgerVAT201 — the figures the return files), so the recon ties what is
 * filed to the control accounts.
 */
export async function getVatExceptions(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<VatExceptionsReport> {
  log.info('Generating VAT exceptions report', { companyId, periodStart, periodEnd }, 'vatExceptionsService');

  const [
    uncoded, ciTaxIssues, siTaxIssues, ciMismatches, siMismatches, glControl, unposted,
    balanceSheetVat, nonSupplyVat, inputSupport, vat201, declaredElsewhere,
  ] =
    await Promise.all([
      // 1. Posted GL lines on VAT control accounts with no vat_type coding.
      // Excludes the VAT submission clearing journal (same predicate and same
      // reasoning as vatControlMovement.ts): its two control-account legs are
      // vat_type NULL by construction, so every filed period grew two
      // exceptions nobody could ever clear — 12 rows in production.
      sql`
        SELECT jl.journal_entry_id, je.entry_number, je.entry_date,
          ga.account_code, ga.account_name, ga.account_subtype,
          COALESCE(je.description, jl.description, '') AS description,
          CASE WHEN ga.account_subtype = 'vat_output'
            THEN jl.credit - jl.debit ELSE jl.debit - jl.credit END AS amount,
          COUNT(*) OVER() AS total_count
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE jl.company_id = ${companyId}::UUID
          AND je.company_id = ${companyId}::UUID
          AND je.status = 'posted'
          AND je.entry_date >= ${periodStart}::DATE
          AND je.entry_date <= ${periodEnd}::DATE
          AND ga.account_subtype IN ('vat_input', 'vat_output')
          AND je.source IS DISTINCT FROM ${VAT_SUBMISSION_CLEARING_SOURCE}
          AND jl.vat_type IS NULL
        ORDER BY je.entry_date, je.entry_number
        LIMIT ${LIST_CAP}
      ` as Promise<Row[]>,
      // 2. Customer invoices with no tax rate, or a rate but zero VAT
      sql`
        SELECT ci.id AS invoice_id, ci.invoice_number, ci.invoice_date,
          ci.subtotal, ci.tax_rate, ci.tax_amount,
          COALESCE(c.name, cl.name, 'Unknown') AS counterparty_name,
          COUNT(*) OVER() AS total_count
        FROM customer_invoices ci
        LEFT JOIN customers c ON c.id = ci.customer_id
        LEFT JOIN clients cl ON cl.id = ci.client_id
        WHERE ci.company_id = ${companyId}::UUID
          AND ci.invoice_date >= ${periodStart}::DATE
          AND ci.invoice_date <= ${periodEnd}::DATE
          AND ci.status != 'cancelled'
          AND (ci.tax_rate IS NULL
            OR (ci.tax_rate > 0 AND COALESCE(ci.tax_amount, 0) = 0 AND ci.subtotal > 0))
        ORDER BY ci.invoice_date, ci.invoice_number
        LIMIT ${LIST_CAP}
      ` as Promise<Row[]>,
      // 3. Supplier invoices with the same tax-code issues
      sql`
        SELECT si.id AS invoice_id, si.invoice_number, si.invoice_date,
          si.subtotal, si.tax_rate, si.tax_amount,
          COALESCE(s.name, 'Unknown') AS counterparty_name,
          COUNT(*) OVER() AS total_count
        FROM supplier_invoices si
        LEFT JOIN suppliers s ON s.id = si.supplier_id
        WHERE si.company_id = ${companyId}::UUID
          AND si.invoice_date >= ${periodStart}::DATE
          AND si.invoice_date <= ${periodEnd}::DATE
          AND si.status != 'cancelled'
          AND (si.tax_rate IS NULL
            OR (si.tax_rate > 0 AND COALESCE(si.tax_amount, 0) = 0 AND si.subtotal > 0))
        ORDER BY si.invoice_date, si.invoice_number
        LIMIT ${LIST_CAP}
      ` as Promise<Row[]>,
      // 4. Customer invoices whose posted GL output VAT differs from invoice VAT.
      // je_any (no status filter) supplies the linked JE's status so a draft
      // JE can be labeled 'je_not_posted' instead of an amount mismatch.
      // je_any joins on the JE primary key, so adding je_any.status to the
      // GROUP BY keeps the one-row-per-invoice cardinality.
      sql`
        SELECT ci.id AS invoice_id, ci.invoice_number, ci.invoice_date,
          COALESCE(c.name, cl.name, 'Unknown') AS counterparty_name,
          COALESCE(ci.tax_amount, 0) AS invoice_vat,
          COALESCE(SUM(CASE WHEN ga.account_subtype = 'vat_output'
            THEN jl.credit - jl.debit ELSE 0 END), 0) AS gl_vat,
          je_any.status AS je_status,
          COUNT(*) OVER() AS total_count
        FROM customer_invoices ci
        LEFT JOIN customers c ON c.id = ci.customer_id
        LEFT JOIN clients cl ON cl.id = ci.client_id
        LEFT JOIN gl_journal_entries je_any
          ON je_any.id = ci.gl_journal_entry_id AND je_any.company_id = ${companyId}::UUID
        LEFT JOIN gl_journal_entries je
          ON je.id = ci.gl_journal_entry_id AND je.status = 'posted'
          AND je.company_id = ${companyId}::UUID
        LEFT JOIN gl_journal_lines jl
          ON jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID
        LEFT JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE ci.company_id = ${companyId}::UUID
          AND ci.invoice_date >= ${periodStart}::DATE
          AND ci.invoice_date <= ${periodEnd}::DATE
          AND ci.status != 'cancelled'
          AND ci.gl_journal_entry_id IS NOT NULL
        GROUP BY ci.id, ci.invoice_number, ci.invoice_date, ci.tax_amount, c.name, cl.name, je_any.status
        HAVING ABS(COALESCE(ci.tax_amount, 0) - COALESCE(SUM(CASE WHEN ga.account_subtype = 'vat_output'
          THEN jl.credit - jl.debit ELSE 0 END), 0)) > ${CENT}
        ORDER BY ci.invoice_date, ci.invoice_number
        LIMIT ${LIST_CAP}
      ` as Promise<Row[]>,
      // 5. Supplier invoices whose posted GL input VAT differs from invoice VAT
      // (je_any: same 'je_not_posted' labeling as the customer query above)
      sql`
        SELECT si.id AS invoice_id, si.invoice_number, si.invoice_date,
          COALESCE(s.name, 'Unknown') AS counterparty_name,
          COALESCE(si.tax_amount, 0) AS invoice_vat,
          COALESCE(SUM(CASE WHEN ga.account_subtype = 'vat_input'
            THEN jl.debit - jl.credit ELSE 0 END), 0) AS gl_vat,
          je_any.status AS je_status,
          COUNT(*) OVER() AS total_count
        FROM supplier_invoices si
        LEFT JOIN suppliers s ON s.id = si.supplier_id
        LEFT JOIN gl_journal_entries je_any
          ON je_any.id = si.gl_journal_entry_id AND je_any.company_id = ${companyId}::UUID
        -- The bill's journal AND its late-claim companion (gl/vatLateClaimSplit),
        -- which carries the input VAT; such a bill is dated by the companion.
        LEFT JOIN gl_journal_entries je
          ON (je.id = si.gl_journal_entry_id OR je.late_claim_of_id = si.gl_journal_entry_id)
          AND je.status = 'posted' AND je.company_id = ${companyId}::UUID
        LEFT JOIN gl_journal_lines jl
          ON jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID
        LEFT JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE si.company_id = ${companyId}::UUID
          AND COALESCE((SELECT lc.entry_date FROM gl_journal_entries lc
                WHERE lc.company_id = ${companyId}::UUID AND lc.late_claim_of_id = si.gl_journal_entry_id
                  AND lc.status = 'posted' AND lc.reversed_at IS NULL LIMIT 1), si.invoice_date) BETWEEN ${periodStart}::DATE AND ${periodEnd}::DATE
          AND si.status != 'cancelled'
          AND si.gl_journal_entry_id IS NOT NULL
        GROUP BY si.id, si.invoice_number, si.invoice_date, si.tax_amount, s.name, je_any.status
        HAVING ABS(COALESCE(si.tax_amount, 0) - COALESCE(SUM(CASE WHEN ga.account_subtype = 'vat_input'
          THEN jl.debit - jl.credit ELSE 0 END), 0)) > ${CENT}
        ORDER BY si.invoice_date, si.invoice_number
        LIMIT ${LIST_CAP}
      ` as Promise<Row[]>,
      // 6. GL VAT control movement — read vatControlMovement.ts before merging it with getVATReturn.
      findVatControlMovement(companyId, periodStart, periodEnd),
      // 7. Issued invoices / approved bills carrying VAT with no journal —
      // BLOCKING since the recon reads the ledger (vatUnpostedInvoices.ts).
      findUnpostedInvoiceVat(companyId, periodStart, periodEnd),
      // 8. VAT claimed against a balance-sheet account with no legitimate
      // reason to carry it. Appended LAST so the existing seven keep their
      // positions — the test helper queues results by index.
      findVatOnBalanceSheetLines(companyId, periodStart, periodEnd),
      // 9. VAT claimed against an account on which no supply can arise —
      // salaries, statutory deductions, taxes, distributions, depreciation,
      // donations, exempt financial services. Appended after 8 for the same
      // reason 8 was appended after 7: the test helper queues by index.
      findVatNonSupplyLines(companyId, periodStart, periodEnd),
      // 10. What supports each input-VAT claim (vatInputSupport.ts). Appended last.
      findInputVatSupport(companyId, periodStart, periodEnd),
      // The FILED fields 5/10 (Hein, 2026-09-25): the invoice-only generateVAT201
      // missed filed VAT on bank, claims, receipts, credit notes and journals.
      getLedgerVAT201(companyId, periodStart, periodEnd),
      // 12. The same population as 7, marked "VAT declared outside IsaFlow"
      // (migration 705) — NOT blocking, appended last so nothing above shifts.
      findVatDeclaredElsewhere(companyId, periodStart, periodEnd),
    ]);

  const uncodedGlLines = uncoded.map(mapUncodedLine);
  const vatOnBalanceSheetLines = balanceSheetVat.map(mapVatOnBalanceSheetLine);
  const vatNonSupplyLines = nonSupplyVat.map(mapVatNonSupplyLine);

  const invoiceTaxCodeIssues = [
    ...ciTaxIssues.map(mapTaxIssue('customer')),
    ...siTaxIssues.map(mapTaxIssue('supplier')),
  ];
  const invoiceGlMismatches = [
    ...ciMismatches.map(mapMismatch('customer')),
    ...siMismatches.map(mapMismatch('supplier')),
  ];

  const gl = glControl[0] ?? {};
  const unpostedInvoiceVat = unposted.map(mapUnpostedInvoice);
  const side = (k: 'customer' | 'supplier') => unpostedInvoiceVat.filter((u) => u.invoiceKind === k);
  const outputGl = r2(toNum(gl.gl_output));
  const inputGl = r2(toNum(gl.gl_input));
  const outputVat201 = r2(vat201.field5_outputVAT);
  const inputVat201 = r2(vat201.field10_totalInputVAT);
  const controlRecon: VatControlRecon = {
    outputVat201,
    outputGl,
    outputVariance: r2(outputVat201 - outputGl),
    inputVat201,
    inputGl,
    inputVariance: r2(inputVat201 - inputGl),
    netVat201: r2(outputVat201 - inputVat201),
    netGl: r2(outputGl - inputGl),
    netVariance: r2((outputVat201 - inputVat201) - (outputGl - inputGl)),
    unpostedCustomerVat: r2(side('customer').reduce((s, u) => s + u.vat, 0)),
    unpostedCustomerCount: side('customer').length,
    unpostedSupplierVat: r2(side('supplier').reduce((s, u) => s + u.vat, 0)),
    unpostedSupplierCount: side('supplier').length,
  };

  const uncodedGlLineCount = totalCount(uncoded);
  const invoiceTaxCodeIssueCount = totalCount(ciTaxIssues) + totalCount(siTaxIssues);
  const invoiceGlMismatchCount = totalCount(ciMismatches) + totalCount(siMismatches);
  const vatOnBalanceSheetCount = totalCount(balanceSheetVat);
  const vatNonSupplyCount = totalCount(nonSupplyVat);
  const reconExceptions =
    (Math.abs(controlRecon.outputVariance) > CENT ? 1 : 0) +
    (Math.abs(controlRecon.inputVariance) > CENT ? 1 : 0);

  return {
    periodStart,
    periodEnd,
    uncodedGlLines,
    uncodedGlLineCount,
    invoiceTaxCodeIssues,
    invoiceTaxCodeIssueCount,
    invoiceGlMismatches,
    invoiceGlMismatchCount,
    vatOnBalanceSheetLines,
    vatOnBalanceSheetCount,
    vatNonSupplyLines,
    vatNonSupplyCount,
    controlRecon,
    unpostedInvoiceVat: unpostedInvoiceVat.slice(0, LIST_CAP),
    unpostedInvoiceVatCount: unpostedInvoiceVat.length,
    declaredElsewhereVat: declaredElsewhere.map(mapDeclaredElsewhere).slice(0, LIST_CAP),
    declaredElsewhereVatCount: declaredElsewhere.length,
    unsupportedInputVat: inputSupport.unsupported.slice(0, LIST_CAP),
    unsupportedInputVatCount: inputSupport.unsupported.length,
    inputVatWithoutTaxInvoice: inputSupport.withoutTaxInvoice.slice(0, LIST_CAP),
    inputVatWithoutTaxInvoiceCount: inputSupport.withoutTaxInvoice.length,
    // The "no tax invoice on file" list is deliberately NOT counted (Hein) —
    // inputSupport.unsupported now holds only `amount_mismatch`,
    // `document_over_claimed` and `document_unlinked` rows (a chain that once
    // had a document and no longer does) (Hein, 2026-09-26): `no_document` and
    // `unreadable_document_vat` moved into the non-blocking
    // inputVatWithoutTaxInvoice list (classifyInputVatSupport,
    // vatInputSupport.ts) because they mean a RECORD is missing, not that the
    // return's figures are wrong. What remains here means the claimed VAT
    // does not tie to what supports it — the figures ARE wrong — so it still
    // counts.
    totalExceptions:
      uncodedGlLineCount + invoiceTaxCodeIssueCount + invoiceGlMismatchCount
      + vatOnBalanceSheetCount + vatNonSupplyCount + reconExceptions
      + inputSupport.unsupported.length + unpostedInvoiceVat.length,
    degradedData: vat201.degradedSources.length > 0,
    degradedSources: vat201.degradedSources,
  };
}
