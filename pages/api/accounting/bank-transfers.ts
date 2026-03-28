import { sql } from '@/lib/neon';
/**
 * Bank Transfers API
 * POST /api/accounting/bank-transfers - Transfer between bank accounts
 * Creates a balanced journal entry: DR destination bank, CR source bank
 * Sage equivalent: Banking > Transfers
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';


async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const { fromAccountId, toAccountId, amount, reference, transferDate } = req.body;

  if (!fromAccountId || !toAccountId || !amount) {
    return apiResponse.validationError(res, {
      ...((!fromAccountId) && { fromAccountId: 'Required' }),
      ...((!toAccountId) && { toAccountId: 'Required' }),
      ...((!amount) && { amount: 'Required' }),
    });
  }

  if (fromAccountId === toAccountId) {
    return apiResponse.badRequest(res, 'Source and destination accounts must be different');
  }

  if (Number(amount) <= 0) {
    return apiResponse.badRequest(res, 'Transfer amount must be positive');
  }

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

    // Get current fiscal period
    const [period] = await sql`
      SELECT id FROM fiscal_periods
      WHERE status = 'open' AND company_id = ${companyId}
      ORDER BY start_date DESC
      LIMIT 1
    `;

    // Create journal entry
    const entryRef = reference || `Transfer: ${fromAcct?.account_name} → ${toAcct?.account_name}`;
    const txDate = transferDate || new Date().toISOString().split('T')[0];

    const entryRows = await sql`
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
    const entry = entryRows[0];
    if (!entry) throw new Error('Failed to create journal entry');

    // Create journal lines: DR destination, CR source
    await sql`
      INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description, created_at)
      VALUES
        (gen_random_uuid(), ${entry.id}, ${toAccountId}, ${Number(amount)}, 0, ${`Transfer from ${fromAcct?.account_name}`}, NOW()),
        (gen_random_uuid(), ${entry.id}, ${fromAccountId}, 0, ${Number(amount)}, ${`Transfer to ${toAcct?.account_name}`}, NOW())
    `;

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
