/**
 * Customer Duplicates API
 * GET /api/accounting/customer-duplicates
 *
 * Returns pairs of customers that are likely duplicates based on:
 * - Matching email address
 * - Matching VAT number
 * - Similar name (ILIKE on first word of name, length > 3)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';
import type { DuplicatePair } from '@/types/customer-duplicates';

export type { DuplicatePair };

type Row = Record<string, unknown>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const rows = (await sql`
      SELECT
        a.id                AS id_a,
        a.name              AS name_a,
        a.email             AS email_a,
        a.vat_number        AS vat_a,
        COALESCE(inv_a.cnt, 0)::int AS invoice_count_a,
        b.id                AS id_b,
        b.name              AS name_b,
        b.email             AS email_b,
        b.vat_number        AS vat_b,
        COALESCE(inv_b.cnt, 0)::int AS invoice_count_b,
        CASE
          WHEN a.email IS NOT NULL AND a.email = b.email
            THEN 'email'
          WHEN a.vat_number IS NOT NULL AND a.vat_number = b.vat_number
            THEN 'vat'
          ELSE 'name'
        END AS match_reason
      FROM customers a
      JOIN customers b
        ON b.id > a.id
        AND b.company_id = a.company_id
        AND b.is_active = true
        AND b.deleted_at IS NULL
      LEFT JOIN (
        SELECT COALESCE(client_id, customer_id) AS cust_id, COUNT(*)::int AS cnt
        FROM customer_invoices
        WHERE company_id = ${companyId}
        GROUP BY 1
      ) inv_a ON inv_a.cust_id = a.id
      LEFT JOIN (
        SELECT COALESCE(client_id, customer_id) AS cust_id, COUNT(*)::int AS cnt
        FROM customer_invoices
        WHERE company_id = ${companyId}
        GROUP BY 1
      ) inv_b ON inv_b.cust_id = b.id
      WHERE a.company_id = ${companyId}
        AND a.is_active = true
        AND a.deleted_at IS NULL
        AND (
          (a.email IS NOT NULL AND a.email = b.email)
          OR (a.vat_number IS NOT NULL AND a.vat_number = b.vat_number)
          OR (
            a.name ILIKE '%' || split_part(b.name, ' ', 1) || '%'
            AND length(split_part(b.name, ' ', 1)) > 3
          )
        )
      ORDER BY match_reason, a.name
      LIMIT 20
    `) as Row[];

    const pairs: DuplicatePair[] = rows.map((r) => ({
      id_a: String(r.id_a),
      name_a: String(r.name_a),
      email_a: r.email_a != null ? String(r.email_a) : null,
      vat_a: r.vat_a != null ? String(r.vat_a) : null,
      invoice_count_a: Number(r.invoice_count_a),
      id_b: String(r.id_b),
      name_b: String(r.name_b),
      email_b: r.email_b != null ? String(r.email_b) : null,
      vat_b: r.vat_b != null ? String(r.vat_b) : null,
      invoice_count_b: Number(r.invoice_count_b),
      match_reason: r.match_reason as DuplicatePair['match_reason'],
    }));

    return apiResponse.success(res, pairs);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('customer-duplicates GET failed', { error: message, module: 'accounting' });
    return apiResponse.internalError(res, err, 'Failed to find duplicate customers');
  }
}

export default withAuth(withErrorHandler(handler as never));
