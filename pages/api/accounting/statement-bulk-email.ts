/**
 * Statement Bulk Email API
 * POST /api/accounting/statement-bulk-email
 * Body: { customerIds: string[], asAtDate: string, message?: string }
 * Returns: { sent: number, failed: number, errors: string[] }
 *
 * Sends a statement PDF email to each selected customer.
 * All queries are company_id scoped. Delegates to statementEmailService.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  withWriteAccess,
  type CompanyAuthedRequest,
  type AuthenticatedNextApiRequest,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { checkRateLimit, checkSendRateLimit } from '@/lib/rateLimit';
import { isValidUUID } from '@/lib/validation';
import { sendStatementEmail } from '@/modules/accounting/services/ar/statementEmailService';

type Row = Record<string, unknown>;

const MAX_BATCH_SIZE = 100;

async function getCompanyMeta(
  companyId: string
): Promise<{ name: string; statementSignature: string | null }> {
  try {
    const rows = (await sql`
      SELECT name, statement_email_signature
      FROM companies
      WHERE id = ${companyId}::UUID
      LIMIT 1
    `) as Row[];
    const row = rows[0];
    return {
      name: row?.name ? String(row.name) : 'ISAFlow',
      statementSignature:
        row?.statement_email_signature != null
          ? String(row.statement_email_signature)
          : null,
    };
  } catch {
    return { name: 'ISAFlow', statementSignature: null };
  }
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId, user } = req as CompanyAuthedRequest;

  // Abuse limit: every attempt counts, whatever comes of it, and it is never
  // given back. It sits ahead of the ownership query below, which the volume
  // charge no longer does (R-175).
  if (!(await checkRateLimit(`statement-bulk-email:attempts:${companyId}:${user.id}`, { max: 30, windowSecs: 900 }))) {
    return apiResponse.tooManyRequests(res, 'Too many send requests. Please try again later.');
  }

  const body = req.body as {
    customerIds?: unknown;
    asAtDate?: unknown;
    message?: unknown;
  };

  if (!Array.isArray(body.customerIds) || body.customerIds.length === 0) {
    return apiResponse.badRequest(res, 'customerIds must be a non-empty array');
  }

  if (body.customerIds.length > MAX_BATCH_SIZE) {
    return apiResponse.badRequest(
      res,
      `customerIds must not exceed ${MAX_BATCH_SIZE} per request`
    );
  }

  const rawIds = body.customerIds as unknown[];
  if (rawIds.some(id => typeof id !== 'string')) {
    return apiResponse.badRequest(res, 'all customerIds must be strings');
  }
  const customerIds = rawIds as string[];
  // Before any query: a non-UUID id would fail the ::UUID cast below as a 500.
  if (customerIds.some(id => !isValidUUID(id))) {
    return apiResponse.badRequest(res, 'all customerIds must be UUIDs');
  }

  if (
    typeof body.asAtDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(body.asAtDate)
  ) {
    return apiResponse.badRequest(
      res,
      'asAtDate must be a valid YYYY-MM-DD date string'
    );
  }
  const asAtDate = body.asAtDate;
  const message =
    typeof body.message === 'string' ? body.message : undefined;

  // IDOR guard — verify all IDs belong to this company
  const owned = (await sql`
    SELECT id FROM customers
    WHERE id = ANY(${customerIds}::UUID[])
      AND company_id = ${companyId}::UUID
  `) as Row[];

  const ownedSet = new Set(owned.map(r => String(r.id)));
  const unauthorized = customerIds.filter(id => !ownedSet.has(id));
  if (unauthorized.length > 0) {
    log.warn(
      'Unauthorized customerIds in statement-bulk-email request',
      { companyId, count: unauthorized.length, sample: unauthorized.slice(0, 3) },
      'statement-bulk-email'
    );
    return apiResponse.forbidden(
      res,
      'One or more customerIds do not belong to this company'
    );
  }

  // Charge the per-company / per-day VOLUME buckets one unit per recipient so a
  // batch can't be used to blow past a real email ceiling; the per-IP bucket
  // stays request-rate (one call = one request). companyMax/dailyMax are email
  // volumes here (not request counts), sized to allow legitimate statement runs
  // (batches are capped at MAX_BATCH_SIZE=100) while bounding an abusive loop.
  // Tunable if a large tenant's monthly run needs more headroom.
  // Charged AFTER the ownership guard (R-175): a request refused there sends
  // nothing, and used to spend one unit per id it named. refundUnused: each
  // email the mail server accepts uses one unit; the rest come back.
  const sendAllowed = await checkSendRateLimit(req, companyId, 'statement-bulk-email', {
    ipMax: 30, // requests / 15 min per IP (cost 1 each)
    companyMax: 2_000, // emails / 15 min per company
    dailyMax: 10_000, // emails / day per company
    count: customerIds.length,
    refundUnused: true,
  });
  if (!sendAllowed) {
    return apiResponse.tooManyRequests(res, 'Too many send requests. Please try again later.');
  }

  const { name: companyName, statementSignature } =
    await getCompanyMeta(companyId);

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  log.info(
    'Starting bulk statement email',
    { companyId, count: customerIds.length, asAtDate },
    'statement-bulk-email'
  );

  for (const customerId of customerIds) {
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

  log.info(
    'Bulk statement email complete',
    { sent, failed },
    'statement-bulk-email'
  );

  return apiResponse.success(res, { sent, failed, errors });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as never))));
