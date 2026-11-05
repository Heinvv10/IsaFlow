/**
 * Company Settings API — Document Numbers & Messages
 * GET  ?type=document-numbers  — get document number config
 * GET  ?type=messages          — get statement/document messages
 * GET  ?type=payment-terms     — the company's default payment terms { payment_terms, payment_terms_type }
 * PUT  ?type=document-numbers  — update document number prefixes
 * PUT  ?type=messages          — update messages
 * PUT  ?type=payment-terms     — set the default payment terms (what a contact with none uses on a new document);
 *                                 owner / admin only (it dates every new invoice and bill of a contact with no terms), recorded
 *                                 in the entity history (migration 959)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withRole, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  getDocumentNumbers, ensureDocumentNumbers, updateDocumentNumber, isRetiredDocumentNumberType,
  getCompanyMessages, upsertCompanyMessages,
} from '@/modules/accounting/services/core/companyService';
import type { CompanyMessage } from '@/modules/accounting/services/core/companyService';
import { getCompanyDefaultTerms, setCompanyDefaultTerms } from '@/modules/accounting/services/core/paymentTermsResolver';
import { ContactValidationError } from '@/modules/accounting/services/core/contactValidationError';

/** PUT ?type=payment-terms, behind withRole('admin'): owners and admins only (the repo's company-wide admin gate). */
async function setDefaultTerms(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const b = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
  try {
    const t = await setCompanyDefaultTerms(companyId, b.payment_terms, b.payment_terms_type);
    return apiResponse.success(res, { payment_terms: t.days, payment_terms_type: t.type });
  } catch (err: unknown) {
    if (err instanceof ContactValidationError) return apiResponse.badRequest(res, err.message);
    throw err;
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const type = req.query.type as string;

  if (req.method === 'GET') {
    if (type === 'document-numbers') {
      const numbers = await ensureDocumentNumbers(companyId);
      return apiResponse.success(res, numbers);
    }
    if (type === 'messages') {
      const messages = await getCompanyMessages(companyId);
      return apiResponse.success(res, messages);
    }
    if (type === 'payment-terms') {
      const t = await getCompanyDefaultTerms(companyId);
      return apiResponse.success(res, { payment_terms: t.days, payment_terms_type: t.type });
    }
    return apiResponse.badRequest(res, 'type query param required: document-numbers, messages or payment-terms');
  }

  if (req.method === 'PUT') {
    if (type === 'document-numbers') {
      const { updates } = req.body as { updates: { documentType: string; prefix: string; nextNumber?: number }[] };
      if (!updates || !Array.isArray(updates)) {
        return apiResponse.badRequest(res, 'updates array required');
      }
      // Validated BEFORE the first write, not inside the loop: `withAuth`
      // COMMITs the request transaction on a 4xx, so refusing halfway would
      // persist the updates already applied.
      const retired = updates.filter((u) => isRetiredDocumentNumberType(u.documentType));
      if (retired.length > 0) {
        return apiResponse.badRequest(
          res,
          `Document type no longer in use: ${retired.map((u) => u.documentType).join(', ')}`,
        );
      }
      for (const u of updates) {
        await updateDocumentNumber(companyId, u.documentType, u.prefix, u.nextNumber);
      }
      const numbers = await getDocumentNumbers(companyId);
      return apiResponse.success(res, numbers);
    }
    if (type === 'messages') {
      const { messages } = req.body as { messages: CompanyMessage[] };
      if (!messages || !Array.isArray(messages)) {
        return apiResponse.badRequest(res, 'messages array required');
      }
      await upsertCompanyMessages(companyId, messages);
      const updated = await getCompanyMessages(companyId);
      return apiResponse.success(res, updated);
    }
    if (type === 'payment-terms') return withRole('admin')(setDefaultTerms)(req, res);
    return apiResponse.badRequest(res, 'type query param required: document-numbers, messages or payment-terms');
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'PUT']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
