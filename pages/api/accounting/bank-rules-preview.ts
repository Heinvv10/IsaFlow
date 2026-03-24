/**
 * Bank Rules Preview API
 * GET — returns count of transactions matching a pattern
 * Query params: bankAccountId, pattern, matchType, matchField
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const { bankAccountId, pattern, matchType = 'contains', matchField = 'description' } = req.query;

  if (!pattern || typeof pattern !== 'string') {
    return apiResponse.badRequest(res, 'pattern is required');
  }

  const raw = pattern.trim();
  if (!raw) return apiResponse.success(res, { matchCount: 0 });

  // Build ILIKE pattern
  let ilike: string;
  if (matchType === 'starts_with') ilike = `${raw}%`;
  else if (matchType === 'ends_with') ilike = `%${raw}`;
  else if (matchType === 'exact') ilike = raw;
  else ilike = `%${raw}%`;

  const bid = typeof bankAccountId === 'string' ? bankAccountId : null;
  const field = typeof matchField === 'string' ? matchField : 'description';

  // Explicit query branches: bankAccountId × matchField (no conditional SQL)
  let rows: Row[];

  if (bid && field === 'description') {
    rows = (await sql`SELECT COUNT(*)::INT AS cnt FROM bank_transactions WHERE bank_account_id = ${bid}::UUID AND description ILIKE ${ilike}`) as Row[];
  } else if (bid && field === 'reference') {
    rows = (await sql`SELECT COUNT(*)::INT AS cnt FROM bank_transactions WHERE bank_account_id = ${bid}::UUID AND reference ILIKE ${ilike}`) as Row[];
  } else if (bid && field === 'both') {
    rows = (await sql`SELECT COUNT(*)::INT AS cnt FROM bank_transactions WHERE bank_account_id = ${bid}::UUID AND (description ILIKE ${ilike} OR reference ILIKE ${ilike})`) as Row[];
  } else if (field === 'reference') {
    rows = (await sql`SELECT COUNT(*)::INT AS cnt FROM bank_transactions WHERE reference ILIKE ${ilike}`) as Row[];
  } else if (field === 'both') {
    rows = (await sql`SELECT COUNT(*)::INT AS cnt FROM bank_transactions WHERE description ILIKE ${ilike} OR reference ILIKE ${ilike}`) as Row[];
  } else {
    rows = (await sql`SELECT COUNT(*)::INT AS cnt FROM bank_transactions WHERE description ILIKE ${ilike}`) as Row[];
  }

  return apiResponse.success(res, { matchCount: Number(rows[0]?.cnt || 0) });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
