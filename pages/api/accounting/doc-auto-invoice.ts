/**
 * Auto-create supplier invoice from captured document extraction
 * POST: match supplier + create invoice from extracted data
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fuzzyMatchSupplier, buildAutoInvoiceFromExtraction, calculateFieldConfidence } from '@/modules/accounting/services/core/docExtractionEnhancedService';
import type { CompanyAuthedRequest } from '@/lib/auth/withAuth';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { documentId } = req.body;
  if (!documentId) return apiResponse.badRequest(res, 'documentId is required');

  const companyId = (req as CompanyAuthedRequest).companyId;

  // Get captured document
  const docs = await sql`SELECT * FROM captured_documents WHERE id = ${documentId} AND company_id = ${companyId}` as Row[];
  if (!docs[0]) return apiResponse.notFound(res, 'Document', documentId);

  const doc = docs[0]!;
  const extracted = doc.extracted_data as Record<string, unknown> & {
    vendorName?: string; vendor?: { name?: string }; documentDate?: string;
    referenceNumber?: string; subtotal?: number; vatAmount?: number;
    totalAmount?: number; lineItems?: { description: string; quantity: number; unitPrice: number; total: number }[];
  };
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
  const supplierMatch = fuzzyMatchSupplier(vendorName, suppliers.map((s: Row) => ({ id: String(s.id), name: String(s.name) })));

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

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
