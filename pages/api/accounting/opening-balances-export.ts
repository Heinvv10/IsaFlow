/**
 * Opening Balances Export API
 * GET — export GL opening balances as CSV
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { neon } from '@neondatabase/serverless';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { log } from '@/lib/logger';

const sql = neon(process.env.DATABASE_URL!);

function csvCell(v: string): string { return `"${String(v || '').replace(/"/g, '""')}"`; }

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);

  try {
    const rows = await sql`
      SELECT a.account_code, a.account_name, a.account_type, a.normal_balance,
        COALESCE(ob.debit, 0) AS opening_debit, COALESCE(ob.credit, 0) AS opening_credit
      FROM gl_accounts a
      LEFT JOIN (
        SELECT gl_account_id,
          SUM(CASE WHEN debit > 0 THEN debit ELSE 0 END) AS debit,
          SUM(CASE WHEN credit > 0 THEN credit ELSE 0 END) AS credit
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        WHERE je.source = 'opening_balance'
        GROUP BY gl_account_id
      ) ob ON ob.gl_account_id = a.id
      ORDER BY a.account_code
    `;

    const csvLines = [
      'Account Code,Account Name,Type,Normal Balance,Opening Debit,Opening Credit',
      ...rows.map((r: Record<string, unknown>) => [
        csvCell(String(r.account_code)),
        csvCell(String(r.account_name)),
        csvCell(String(r.account_type)),
        csvCell(String(r.normal_balance)),
        Number(r.opening_debit || 0).toFixed(2),
        Number(r.opening_credit || 0).toFixed(2),
      ].join(',')),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="opening-balances-${new Date().toISOString().split('T')[0]}.csv"`);
    return res.status(200).send(csvLines.join('\n'));
  } catch (err) {
    log.error('Opening balances export failed', { error: err });
    return apiResponse.badRequest(res, 'Failed to export opening balances');
  }
}

export default withAuth(handler);
