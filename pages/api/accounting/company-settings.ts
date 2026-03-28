/**
 * Company Settings API — Document Numbers & Messages
 * GET  ?type=document-numbers  — get document number config
 * GET  ?type=messages          — get statement/document messages
 * PUT  ?type=document-numbers  — update document number prefixes
 * PUT  ?type=messages          — update messages
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import {
  getDocumentNumbers, ensureDocumentNumbers, updateDocumentNumber,
  getCompanyMessages, upsertCompanyMessages,
} from '@/modules/accounting/services/companyService';
import type { CompanyMessage } from '@/modules/accounting/services/companyService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
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
    return apiResponse.badRequest(res, 'type query param required: document-numbers or messages');
  }

  if (req.method === 'PUT') {
    if (type === 'document-numbers') {
      const { updates } = req.body as { updates: { documentType: string; prefix: string; nextNumber?: number }[] };
      if (!updates || !Array.isArray(updates)) {
        return apiResponse.badRequest(res, 'updates array required');
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
    return apiResponse.badRequest(res, 'type query param required: document-numbers or messages');
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'PUT']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
