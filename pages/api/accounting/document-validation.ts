/**
 * Document Validation API
 * POST /api/accounting/document-validation
 * Body: { entityType, entityId, documentId }
 * Validates VLM-extracted data against the entity record.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  validateInvoiceDocument,
  validatePaymentReceipt,
} from '@/modules/accounting/services/documentValidationService';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const { entityType, entityId, documentId } = req.body as {
    entityType?: string;
    entityId?: string;
    documentId?: string;
  };

  if (!entityType || !entityId || !documentId) {
    return apiResponse.badRequest(res, 'entityType, entityId, and documentId are required');
  }

  // Fetch extracted data from document — scoped to company
  const [doc] = (await sql`
    SELECT extracted_data FROM procurement_documents
    WHERE id = ${documentId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];

  if (!doc?.extracted_data) {
    return apiResponse.badRequest(res, 'Document has no extracted data. VLM extraction may not have completed.');
  }

  const extracted = doc.extracted_data as ExtractedDocument;
  let result;

  if (entityType === 'supplier_invoice') {
    const [invoice] = (await sql`
      SELECT invoice_number, total_amount, tax_amount as vat_amount, tax_rate
      FROM supplier_invoices WHERE id = ${entityId}::uuid AND company_id = ${companyId}::uuid
    `) as Row[];
    if (!invoice) return apiResponse.notFound(res, 'Supplier invoice', entityId);

    // Get supplier name
    const [supplier] = (await sql`
      SELECT name FROM suppliers WHERE id = (
        SELECT supplier_id FROM supplier_invoices WHERE id = ${entityId}::uuid AND company_id = ${companyId}::uuid
      )
    `) as Row[];

    result = validateInvoiceDocument(extracted, {
      invoiceNumber: invoice.invoice_number,
      totalAmount: parseFloat(invoice.total_amount),
      vatAmount: invoice.vat_amount ? parseFloat(invoice.vat_amount) : undefined,
      taxRate: invoice.tax_rate ? parseFloat(invoice.tax_rate) : undefined,
      vendorName: supplier?.name,
    });
  } else if (entityType === 'customer_invoice') {
    const [invoice] = (await sql`
      SELECT invoice_number, total_amount, tax_amount, invoice_date
      FROM customer_invoices WHERE id = ${entityId}::uuid AND company_id = ${companyId}::uuid
    `) as Row[];
    if (!invoice) return apiResponse.notFound(res, 'Customer invoice', entityId);

    result = validateInvoiceDocument(extracted, {
      invoiceNumber: invoice.invoice_number,
      totalAmount: parseFloat(invoice.total_amount),
      vatAmount: invoice.tax_amount ? parseFloat(invoice.tax_amount) : undefined,
      invoiceDate: invoice.invoice_date ? new Date(invoice.invoice_date).toISOString().split('T')[0] : undefined,
    });
  } else if (entityType === 'supplier_payment' || entityType === 'customer_payment') {
    const [payment] = entityType === 'supplier_payment'
      ? (await sql`SELECT total_amount, payment_date, reference FROM supplier_payments WHERE id = ${entityId}::uuid AND company_id = ${companyId}::uuid`) as Row[]
      : (await sql`SELECT total_amount, payment_date, reference FROM customer_payments WHERE id = ${entityId}::uuid AND company_id = ${companyId}::uuid`) as Row[];
    if (!payment) return apiResponse.notFound(res, entityType, entityId);

    result = validatePaymentReceipt(extracted, {
      totalAmount: parseFloat(payment.total_amount),
      paymentDate: payment.payment_date ? new Date(payment.payment_date).toISOString().split('T')[0] : undefined,
      reference: payment.reference,
    });
  } else {
    return apiResponse.badRequest(res, `Unsupported entity type: ${entityType}`);
  }

  // Store validation result
  // @ts-expect-error — auth middleware attaches user
  const userId: string | null = req.user?.id ?? null;

  await sql`
    INSERT INTO document_validation_results (
      company_id, document_id, entity_type, entity_id,
      validation_type, result_data, discrepancy_count, validated_by
    ) VALUES (
      ${companyId}::uuid, ${documentId}::uuid, ${entityType}, ${entityId}::uuid,
      'vlm_document_match', ${JSON.stringify(result)}::jsonb,
      ${result.discrepancies.length}, ${userId}
    )
  `;

  log.info('Document validation completed', {
    entityType,
    entityId,
    documentId,
    valid: result.valid,
    discrepancies: result.discrepancies.length,
  }, 'document-validation');

  return apiResponse.success(res, result);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
