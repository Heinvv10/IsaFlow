/**
 * Cash Movement Report API
 * GET /api/accounting/reports/cash-movement
 *
 * Returns bank account transactions grouped by account, showing inflows,
 * outflows, net movement, and running balances for a date range.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';

export interface CashMovementRow {
  account_id: string;
  account_name: string;
  account_number: string | null;
  opening_balance: number;
  inflows: number;
  outflows: number;
  net_movement: number;
  closing_balance: number;
}

export interface CashMovementTotals {
  opening_balance: number;
  inflows: number;
  outflows: number;
  net_movement: number;
  closing_balance: number;
}

export interface CashMovementResponse {
  from: string;
  to: string;
  accounts: CashMovementRow[];
  totals: CashMovementTotals;
}

function currentMonthStart(): string {
  const d = new Date();
  const iso = new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
  return iso.substring(0, 10);
}

function today(): string {
  return new Date().toISOString().substring(0, 10);
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  const from =
    typeof req.query.from === 'string' && req.query.from
      ? req.query.from
      : currentMonthStart();
  const to =
    typeof req.query.to === 'string' && req.query.to
      ? req.query.to
      : today();

  try {
    // Opening balance = sum of all transactions BEFORE the period start
    const openingRows = await sql`
      SELECT
        ga.id                                    AS account_id,
        ga.account_name,
        ga.bank_account_number                   AS account_number,
        COALESCE(SUM(bt.amount), 0)::numeric     AS opening_balance
      FROM gl_accounts ga
      LEFT JOIN bank_transactions bt
        ON bt.bank_account_id = ga.id
        AND bt.transaction_date < ${from}::date
        AND bt.status != 'excluded'
      -- No is_active filter. It is a chart-of-accounts picker flag, so a
      -- deactivated bank account would drop off this report while still holding
      -- a real balance and unreconciled transactions. The zero delta today is
      -- luck, not safety: no inactive bank account currently carries a
      -- bank_transactions row, but deactivating 1049686 would silently remove
      -- R1.9m from this report. Do not reinstate it.
      WHERE ga.company_id = ${companyId}
        AND ga.account_subtype = 'bank'
      GROUP BY ga.id, ga.account_name, ga.bank_account_number
      ORDER BY ga.account_code
    `;

    // Period movements
    const movementRows = await sql`
      SELECT
        ga.id                                                          AS account_id,
        COALESCE(
          SUM(CASE WHEN bt.amount > 0 THEN bt.amount    ELSE 0 END),
          0
        )::numeric                                                     AS inflows,
        COALESCE(
          SUM(CASE WHEN bt.amount < 0 THEN ABS(bt.amount) ELSE 0 END),
          0
        )::numeric                                                     AS outflows
      FROM gl_accounts ga
      LEFT JOIN bank_transactions bt
        ON bt.bank_account_id = ga.id
        AND bt.transaction_date >= ${from}::date
        AND bt.transaction_date <= ${to}::date
        AND bt.status != 'excluded'
      -- No is_active filter. It is a chart-of-accounts picker flag, so a
      -- deactivated bank account would drop off this report while still holding
      -- a real balance and unreconciled transactions. The zero delta today is
      -- luck, not safety: no inactive bank account currently carries a
      -- bank_transactions row, but deactivating 1049686 would silently remove
      -- R1.9m from this report. Do not reinstate it.
      WHERE ga.company_id = ${companyId}
        AND ga.account_subtype = 'bank'
      GROUP BY ga.id
    `;

    // Index movement by account_id for O(n) merge
    const movementMap = new Map<string, { inflows: number; outflows: number }>();
    for (const r of movementRows) {
      movementMap.set(String(r.account_id), {
        inflows: Number(r.inflows),
        outflows: Number(r.outflows),
      });
    }

    const accounts: CashMovementRow[] = openingRows.map(r => {
      const accountId = String(r.account_id);
      const opening = Number(r.opening_balance);
      const mv = movementMap.get(accountId) ?? { inflows: 0, outflows: 0 };
      const net = mv.inflows - mv.outflows;
      return {
        account_id: accountId,
        account_name: String(r.account_name),
        account_number: r.account_number ? String(r.account_number) : null,
        opening_balance: opening,
        inflows: mv.inflows,
        outflows: mv.outflows,
        net_movement: net,
        closing_balance: opening + net,
      };
    });

    const totals: CashMovementTotals = accounts.reduce(
      (acc, row) => ({
        opening_balance: acc.opening_balance + row.opening_balance,
        inflows: acc.inflows + row.inflows,
        outflows: acc.outflows + row.outflows,
        net_movement: acc.net_movement + row.net_movement,
        closing_balance: acc.closing_balance + row.closing_balance,
      }),
      { opening_balance: 0, inflows: 0, outflows: 0, net_movement: 0, closing_balance: 0 },
    );

    const payload: CashMovementResponse = { from, to, accounts, totals };
    return apiResponse.success(res, payload);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('cash-movement report error', { error: message });
    return apiResponse.error(res, ErrorCode.INTERNAL_ERROR, 'Failed to generate cash movement report');
  }
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withAuth>[0]));
