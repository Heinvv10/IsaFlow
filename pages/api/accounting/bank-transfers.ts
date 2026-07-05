import { sql, fmtDate, withTransaction } from '@/lib/neon';
/**
 * Bank Transfers API
 * POST /api/accounting/bank-transfers - Transfer between bank accounts
 * Creates a balanced journal entry: DR destination bank, CR source bank
 * Sage equivalent: Banking > Transfers
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';

const TransferSchema = z.object({
  fromAccountId: UUID,
  toAccountId: UUID,
  amount: z.union([z.number(), z.string()]).transform(v => Number(v)).refine(n => Number.isFinite(n) && n > 0, {
    message: 'Transfer amount must be a positive number',
  }),
  reference: z.string().max(500).optional(),
  transferDate: z.string().max(30).optional(),
}).refine(v => v.fromAccountId !== v.toAccountId, {
  message: 'Source and destination accounts must be different',
  path: ['toAccountId'],
});


async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const parsed = TransferSchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }
  const { fromAccountId, toAccountId, amount, reference, transferDate } = parsed.data;

  try {
    // Verify both accounts exist and are bank accounts
    const accounts = await sql`
      SELECT id, account_code, account_name, account_subtype
      FROM gl_accounts
      WHERE id IN (${fromAccountId}, ${toAccountId}) AND company_id = ${companyId}
    `;

    if (accounts.length !== 2) {
      return apiResponse.badRequest(res, 'One or both accounts not found');
    }

    const fromAcct = accounts.find(a => a.id === fromAccountId);
    const toAcct = accounts.find(a => a.id === toAccountId);

    // Create journal entry + lines atomically
    const entryRef = reference || `Transfer: ${fromAcct?.account_name} → ${toAcct?.account_name}`;
    const txDate = transferDate || fmtDate(new Date());

    // Period must COVER the transfer date (P2.2): "most recent open period"
    // misfiled back/post-dated transfers into the wrong period.
    const [period] = await sql`
      SELECT id FROM fiscal_periods
      WHERE company_id = ${companyId}
        AND ${txDate}::DATE BETWEEN start_date AND end_date
      ORDER BY start_date
      LIMIT 1
    `;

    const entry = await withTransaction(async (tx) => {  

      const entryRows = await tx`
        INSERT INTO gl_journal_entries (
          id, entry_number, entry_date, description,
          source, status, fiscal_period_id,
          total_debit, total_credit,
          created_by, created_at, company_id
        ) VALUES (
          gen_random_uuid(),
          'TXF-' || LPAD((SELECT COALESCE(MAX(CAST(SUBSTRING(entry_number FROM 5) AS INTEGER)), 0) + 1 FROM gl_journal_entries WHERE entry_number LIKE 'TXF-%' AND company_id = ${companyId})::text, 4, '0'),
          ${txDate}, ${entryRef},
          'bank_transfer', 'posted', ${period?.id || null},
          ${Number(amount)}, ${Number(amount)},
          ${userId}, NOW(), ${companyId}
        )
        RETURNING *
      `;
      const newEntry = entryRows[0] as { id: string } | undefined;
      if (!newEntry) throw new Error('Failed to create journal entry');

      // Create journal lines within same transaction: DR destination, CR source
      await tx`
        INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description, created_at, company_id)
        VALUES
          (gen_random_uuid(), ${newEntry.id}, ${toAccountId}, ${Number(amount)}, 0, ${`Transfer from ${fromAcct?.account_name}`}, NOW(), ${companyId}::UUID),
          (gen_random_uuid(), ${newEntry.id}, ${fromAccountId}, 0, ${Number(amount)}, ${`Transfer to ${toAcct?.account_name}`}, NOW(), ${companyId}::UUID)
      `;
      return newEntry;
    });

    log.info('Bank transfer completed', {
      entryId: entry.id,
      from: fromAcct?.account_code,
      to: toAcct?.account_code,
      amount,
      module: 'accounting',
    });

    return apiResponse.success(res, {
      journalEntry: entry,
      message: `Transferred R${Number(amount).toFixed(2)} from ${fromAcct?.account_name} to ${toAcct?.account_name}`,
    });
  } catch (err) {
    log.error('Failed to process bank transfer', { error: err, module: 'accounting' });
    return apiResponse.databaseError(res, err, 'Failed to process bank transfer');
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
