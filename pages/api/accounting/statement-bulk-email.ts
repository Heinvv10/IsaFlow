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
  withCompany,
  withWriteAccess,
  type CompanyApiRequest,
  type AuthenticatedNextApiRequest,
} from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
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

  const { companyId } = req as CompanyApiRequest;

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
      { companyId, unauthorized },
      'statement-bulk-email'
    );
    return apiResponse.forbidden(
      res,
      'One or more customerIds do not belong to this company'
    );
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

export default withCompany(withErrorHandler(withWriteAccess(handler as never)));
