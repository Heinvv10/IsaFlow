/**
 * Bank Import Batches API
 * GET /api/accounting/bank-import-batches?bankAccountId=<uuid>
 * Returns the most recent import batches for a bank account, used by the
 * Statement Balance Widget to display opening/closing balances per statement.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

// 🟢 WORKING: Import batch row shape returned from DB
type ImportBatchRow = {
  id: string;
  bank_account_id: string;
  statement_date: string | Date;
  bank_format: string | null;
  opening_balance: string | null;
  closing_balance: string | null;
  transaction_count: string | number;
  created_at: string | Date;
};

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { bankAccountId } = req.query;

  if (!bankAccountId || typeof bankAccountId !== 'string' || bankAccountId.trim() === '') {
    return apiResponse.badRequest(res, 'bankAccountId query parameter is required');
  }

  try {
    const rows = (await sql`
      SELECT
        id,
        bank_account_id,
        statement_date,
        bank_format,
        opening_balance,
        closing_balance,
        transaction_count,
        created_at
      FROM bank_import_batches
      WHERE bank_account_id = ${bankAccountId}::UUID
      ORDER BY created_at DESC
      LIMIT 20
    `) as ImportBatchRow[];

    const batches = rows.map(r => ({
      id: r.id,
      statementDate: r.statement_date instanceof Date
        ? r.statement_date.toISOString().split('T')[0]
        : String(r.statement_date).split('T')[0],
      bankFormat: r.bank_format ?? null,
      openingBalance: r.opening_balance !== null ? Number(r.opening_balance) : null,
      closingBalance: r.closing_balance !== null ? Number(r.closing_balance) : null,
      transactionCount: Number(r.transaction_count),
      createdAt: r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
    }));

    return apiResponse.success(res, { batches });
  } catch (err) {
    log.error('Failed to get bank import batches', { error: err }, 'accounting-api');
    return apiResponse.success(res, { batches: [] });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
