/**
 * Auto-create supplier invoice from captured document extraction
 * POST: match supplier + create invoice from extracted data
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fuzzyMatchSupplier, buildAutoInvoiceFromExtraction, calculateFieldConfidence } from '@/modules/accounting/services/docExtractionEnhancedService';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { documentId } = req.body;
  if (!documentId) return apiResponse.badRequest(res, 'documentId is required');

  const companyId = (req as any).companyId as string;

  // Get captured document
  const docs = await sql`SELECT * FROM captured_documents WHERE id = ${documentId}` as Row[];
  if (!docs[0]) return apiResponse.notFound(res, 'Document', documentId);

  const doc = docs[0] as any;
  const extracted = doc.extracted_data;
  if (!extracted) return apiResponse.badRequest(res, 'Document has no extracted data');

  // Calculate field confidence
  const fieldConfidence = calculateFieldConfidence({
    vendorName: extracted.vendorName || extracted.vendor?.name || '',
    documentDate: extracted.documentDate || '',
    referenceNumber: extracted.referenceNumber || '',
    subtotal: Number(extracted.subtotal || 0),
    vatAmount: Number(extracted.vatAmount || 0),
    totalAmount: Number(extracted.totalAmount || 0),
    lineItems: extracted.lineItems || [],
  });

  // Fuzzy match supplier
  const suppliers = await sql`SELECT id, name FROM suppliers WHERE company_id = ${companyId}::UUID AND is_active = true` as Row[];
  const vendorName = extracted.vendorName || extracted.vendor?.name || '';
  const supplierMatch = fuzzyMatchSupplier(vendorName, suppliers.map((s: any) => ({ id: String(s.id), name: String(s.name) })));

  if (!supplierMatch) {
    return apiResponse.success(res, {
      matched: false,
      message: `No supplier match found for "${vendorName}"`,
      fieldConfidence,
      extractedData: extracted,
    });
  }

  // Build auto-invoice data
  const invoiceData = buildAutoInvoiceFromExtraction({
    vendorName,
    documentDate: extracted.documentDate || '',
    referenceNumber: extracted.referenceNumber || '',
    subtotal: Number(extracted.subtotal || 0),
    vatAmount: Number(extracted.vatAmount || 0),
    totalAmount: Number(extracted.totalAmount || 0),
    lineItems: extracted.lineItems || [],
  }, supplierMatch.supplierId);

  log.info('Auto-invoice prepared from document', {
    documentId, supplierId: supplierMatch.supplierId, total: invoiceData.totalAmount,
  }, 'ai');

  return apiResponse.success(res, {
    matched: true,
    supplierMatch,
    invoiceData,
    fieldConfidence,
  });
}

export default withCompany(withErrorHandler(handler as any));
