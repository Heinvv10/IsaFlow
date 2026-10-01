/**
 * Customer Statements Bulk Send API
 * POST /api/accounting/customer-statements-send
 * Body: { customer_ids: string[], as_at_date: string, message?: string }
 * Returns: { sent: number, failed: number, errors: string[] }
 *
 * Fetches each customer's statement and emails it via statementEmailService.
 * All queries are company_id scoped.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { checkRateLimit, checkSendRateLimit } from '@/lib/rateLimit';
import { isValidUUID } from '@/lib/validation';
import { sendStatementEmail } from '@/modules/accounting/services/ar/statementEmailService';

type Row = Record<string, unknown>;

interface CompanyMeta {
  name: string;
  statementSignature: string | null;
}

async function getCompanyMeta(companyId: string): Promise<CompanyMeta> {
  try {
    const rows = await sql`
      SELECT name, statement_email_signature
      FROM companies
      WHERE id = ${companyId}::UUID
      LIMIT 1
    ` as Row[];
    const row = rows[0];
    return {
      name: row?.name ? String(row.name) : 'ISAFlow',
      statementSignature: row?.statement_email_signature != null
        ? String(row.statement_email_signature)
        : null,
    };
  } catch {
    return { name: 'ISAFlow', statementSignature: null };
  }
}

// Cap the number of customers per request to prevent bulk-email abuse
const MAX_BATCH_SIZE = 100;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId, user } = req as CompanyAuthedRequest;

  // Abuse limit: every attempt counts, per user and company (30), and per user
  // across all their companies (90), and is never given back. The company's send bucket below is shared by every colleague, so it
  // is charged only once the request is well formed and names records the
  // company owns (R-175).
  if (!(await checkRateLimit(`customer-statements:attempts:${companyId}:${user.id}`, { max: 30, windowSecs: 900 }))
    || !(await checkRateLimit(`customer-statements:user-attempts:${user.id}`, { max: 90, windowSecs: 900 }))) {
    return apiResponse.tooManyRequests(res, 'Too many send requests. Please try again later.');
  }

  const body = req.body as {
    customer_ids?: unknown;
    as_at_date?: unknown;
    message?: unknown;
  };

  // Validate input
  if (!Array.isArray(body.customer_ids) || body.customer_ids.length === 0) {
    return apiResponse.badRequest(res, 'customer_ids must be a non-empty array');
  }

  if (body.customer_ids.length > MAX_BATCH_SIZE) {
    return apiResponse.badRequest(res, `customer_ids must not exceed ${MAX_BATCH_SIZE} per request`);
  }

  const customerIds = body.customer_ids as unknown[];
  if (customerIds.some(id => typeof id !== 'string')) {
    return apiResponse.badRequest(res, 'all customer_ids must be strings');
  }

  const validIds = customerIds as string[];
  // Before any query: a non-UUID id would fail the ::UUID cast below as a 500.
  if (validIds.some(id => !isValidUUID(id))) {
    return apiResponse.badRequest(res, 'all customer_ids must be UUIDs');
  }

  if (typeof body.as_at_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.as_at_date)) {
    return apiResponse.badRequest(res, 'as_at_date must be a valid YYYY-MM-DD date string');
  }

  const asAtDate = body.as_at_date;
  const message = typeof body.message === 'string' ? body.message : undefined;

  // Verify all requested customer IDs belong to this company (IDOR guard)
  const owned = await sql`
    SELECT id FROM customers
    WHERE id = ANY(${validIds}::UUID[]) AND company_id = ${companyId}::UUID
  ` as Row[];

  const ownedIds = new Set(owned.map(r => String(r.id)));
  const unauthorized = validIds.filter(id => !ownedIds.has(id));
  if (unauthorized.length > 0) {
    log.warn('Unauthorized customer_ids in statement send request', {
      companyId,
      count: unauthorized.length,
      sample: unauthorized.slice(0, 3),
    }, 'customer-statements-send');
    return apiResponse.forbidden(res, 'One or more customer IDs do not belong to this company');
  }

  const sendAllowed = await checkSendRateLimit(req, companyId, 'customer-statements', { refundUnused: true });
  if (!sendAllowed) {
    return apiResponse.tooManyRequests(res, 'Too many send requests. Please try again later.');
  }

  const { name: companyName, statementSignature } = await getCompanyMeta(companyId);

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  log.info('Starting bulk statement send', {
    companyId,
    count: validIds.length,
    asAtDate,
  }, 'customer-statements-send');

  for (const customerId of validIds) {
    const result = await sendStatementEmail(
      companyId,
      customerId,
      asAtDate,
      companyName,
      message,
      statementSignature
    );

    if (result.success) {
      sent++;
    } else {
      failed++;
      errors.push(result.error ?? `Failed to send to customer ${customerId}`);
    }
  }

  log.info('Bulk statement send complete', { sent, failed }, 'customer-statements-send');

  return apiResponse.success(res, { sent, failed, errors });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as never))));
