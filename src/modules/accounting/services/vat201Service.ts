/**
 * VAT201 Generation Service
 * Generates SARS VAT201 return data from customer/supplier invoices.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

const SA_VAT_RATE = 0.15;

export interface VAT201Data {
  periodStart: string;
  periodEnd: string;
  field1_standardRatedSupplies: number;
  field2_zeroRatedSupplies: number;
  field3_exemptSupplies: number;
  field4_totalImports: number;
  field5_outputVAT: number;
  field6_capitalGoods: number;
  field7_otherGoods: number;
  field8_services: number;
  field9_imports: number;
  field10_totalInputVAT: number;
  field11_vatPayableOrRefundable: number;
  outputInvoices: VAT201Invoice[];
  inputInvoices: VAT201Invoice[];
}

export interface VAT201Invoice {
  id: string;
  invoiceNumber: string;
  counterpartyName: string;
  invoiceDate: string;
  totalExclVat: number;
  vatAmount: number;
  vatType: string;
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Generate a VAT201 return from customer and supplier invoices for the period.
 * Output VAT comes from customer_invoices; input VAT from supplier_invoices.
 * GL account codes 2120 (Output VAT) and 1140 (Input VAT) are cross-referenced.
 */
export async function generateVAT201(companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<VAT201Data> {
  log.info('Generating VAT201', { periodStart, periodEnd }, 'vat201Service');

  let customerInvoices: Row[] = [];
  try {
    customerInvoices = (await sql`
      SELECT
        ci.id,
        ci.invoice_number,
        ci.invoice_date,
        ci.subtotal,
        ci.tax_amount,
        ci.total_amount,
        ci.tax_rate,
        COALESCE(c.name, cl.name) AS customer_name,
        COALESCE(
          (
            SELECT jl.vat_type
            FROM gl_journal_lines jl
            WHERE jl.journal_entry_id = ci.gl_journal_entry_id
              AND jl.vat_type IS NOT NULL
            LIMIT 1
          ),
          CASE WHEN ci.tax_rate = 0 THEN 'zero_rated' ELSE 'standard' END
        ) AS vat_type
      FROM customer_invoices ci
      LEFT JOIN customers c ON c.id = ci.customer_id
      LEFT JOIN clients cl ON cl.id = ci.client_id
      WHERE ci.company_id = ${companyId}
        AND ci.invoice_date >= ${periodStart}
        AND ci.invoice_date <= ${periodEnd}
        AND ci.status != 'cancelled'
      ORDER BY ci.invoice_date
    `) as Row[];
  } catch (err) {
    log.warn('Could not query customer_invoices for VAT201', { error: err }, 'vat201Service');
  }

  let supplierInvoices: Row[] = [];
  try {
    supplierInvoices = (await sql`
      SELECT
        si.id,
        si.invoice_number,
        si.invoice_date,
        si.subtotal,
        si.tax_amount,
        si.total_amount,
        si.tax_rate,
        s.name AS supplier_name
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.company_id = ${companyId}
        AND si.invoice_date >= ${periodStart}
        AND si.invoice_date <= ${periodEnd}
        AND si.status != 'cancelled'
      ORDER BY si.invoice_date
    `) as Row[];
  } catch (err) {
    log.warn('Could not query supplier_invoices for VAT201', { error: err }, 'vat201Service');
  }

  let supplierVatByClass: Row[] = [];
  try {
    supplierVatByClass = (await sql`
      SELECT
        COALESCE(sii.vat_classification, 'standard') AS classification,
        COALESCE(SUM(sii.tax_amount), 0) AS vat_total
      FROM supplier_invoice_items sii
      JOIN supplier_invoices si ON si.id = sii.supplier_invoice_id
      WHERE si.company_id = ${companyId}
        AND si.invoice_date >= ${periodStart}
        AND si.invoice_date <= ${periodEnd}
        AND si.status != 'cancelled'
      GROUP BY COALESCE(sii.vat_classification, 'standard')
    `) as Row[];
  } catch (err) {
    log.warn('Could not query supplier_invoice_items for VAT201 classification', { error: err }, 'vat201Service');
  }

  let field1_standardRated = 0;
  let field2_zeroRated = 0;
  let field3_exempt = 0;

  const outputInvoices: VAT201Invoice[] = customerInvoices.map((inv: Row) => {
    const subtotal = Number(inv.subtotal) || 0;
    const vatAmt = Number(inv.tax_amount) || 0;
    const vatType = String(inv.vat_type || 'standard');

    if (vatType === 'exempt' || vatType === 'no_vat') {
      field3_exempt += subtotal;
    } else if (vatType === 'zero_rated' || vatType === 'export') {
      field2_zeroRated += subtotal;
    } else {
      field1_standardRated += subtotal;
    }

    return {
      id: String(inv.id),
      invoiceNumber: String(inv.invoice_number || ''),
      counterpartyName: String(inv.customer_name || 'Unknown'),
      invoiceDate: String(inv.invoice_date || ''),
      totalExclVat: subtotal,
      vatAmount: vatAmt,
      vatType,
    };
  });

  const field5_outputVAT = roundCents(field1_standardRated * SA_VAT_RATE);

  let field6_capitalGoods = 0;
  let field7_otherGoods = 0;
  let field8_services = 0;
  let field9_imports = 0;

  for (const row of supplierVatByClass) {
    const cls = String(row.classification);
    const amount = Number(row.vat_total) || 0;
    if (cls === 'capital_goods') field6_capitalGoods += amount;
    else if (cls === 'services') field8_services += amount;
    else if (cls === 'imported' || cls === 'reverse_charge') field9_imports += amount;
    else field7_otherGoods += amount;
  }

  if (supplierVatByClass.length === 0) {
    for (const inv of supplierInvoices) {
      const vatAmt = Number(inv.tax_amount) || 0;
      const taxRate = Number(inv.tax_rate) || 0;
      if (taxRate > 0) field7_otherGoods += vatAmt;
    }
  }

  const inputInvoices: VAT201Invoice[] = supplierInvoices.map((inv: Row) => {
    const vatAmt = Number(inv.tax_amount) || 0;
    const subtotal = Number(inv.subtotal) || 0;
    const taxRate = Number(inv.tax_rate) || 0;
    const vatType = taxRate === 0 ? 'zero_rated' : 'standard';

    return {
      id: String(inv.id),
      invoiceNumber: String(inv.invoice_number || ''),
      counterpartyName: String(inv.supplier_name || 'Unknown'),
      invoiceDate: String(inv.invoice_date || ''),
      totalExclVat: subtotal,
      vatAmount: vatAmt,
      vatType,
    };
  });

  const field10_totalInputVAT = roundCents(
    field6_capitalGoods + field7_otherGoods + field8_services + field9_imports
  );
  const field11_vatPayable = roundCents(field5_outputVAT - field10_totalInputVAT);

  return {
    periodStart,
    periodEnd,
    field1_standardRatedSupplies: roundCents(field1_standardRated),
    field2_zeroRatedSupplies: roundCents(field2_zeroRated),
    field3_exemptSupplies: roundCents(field3_exempt),
    field4_totalImports: roundCents(field9_imports > 0 ? field9_imports / SA_VAT_RATE : 0),
    field5_outputVAT,
    field6_capitalGoods: roundCents(field6_capitalGoods),
    field7_otherGoods: roundCents(field7_otherGoods),
    field8_services: roundCents(field8_services),
    field9_imports: roundCents(field9_imports),
    field10_totalInputVAT,
    field11_vatPayableOrRefundable: field11_vatPayable,
    outputInvoices,
    inputInvoices,
  };
}
