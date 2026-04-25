/**
 * GET /api/accounting/setup-guide
 * Returns auto-detected completed task IDs based on company data.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

interface CompanyRow {
  logo_data: string | null;
  registration_number: string | null;
  vat_number: string | null;
}

interface CountRow {
  count: string;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  // Each probe is isolated — a missing table, schema drift, or a single
  // query error must not 400 the whole endpoint. A brand-new company will
  // have empty tables across the board; the safe fallback is "nothing done".
  const safeCount = async (q: Promise<unknown>): Promise<number> => {
    try {
      const rows = (await q) as CountRow[];
      return Number(rows[0]?.count ?? 0);
    } catch (err) {
      log.warn('Setup guide probe failed', { error: err }, 'setup-guide');
      return 0;
    }
  };

  const safeCompany = async (): Promise<CompanyRow | null> => {
    try {
      const rows = (await sql`
        SELECT logo_data, registration_number, vat_number
        FROM companies
        WHERE id = ${companyId}
        LIMIT 1
      `) as CompanyRow[];
      return rows[0] ?? null;
    } catch (err) {
      log.warn('Setup guide company probe failed', { error: err }, 'setup-guide');
      return null;
    }
  };

  const [
    company,
    bankAccountCount,
    bankTxCount,
    invoiceCount,
    customerCount,
    supplierCount,
    fiscalCount,
    openingCount,
  ] = await Promise.all([
    safeCompany(),
    safeCount(sql`SELECT COUNT(*) AS count FROM bank_accounts WHERE company_id = ${companyId}`),
    safeCount(sql`SELECT COUNT(*) AS count FROM bank_transactions WHERE company_id = ${companyId}`),
    safeCount(sql`SELECT COUNT(*) AS count FROM customer_invoices WHERE company_id = ${companyId}`),
    safeCount(sql`SELECT COUNT(*) AS count FROM customers WHERE company_id = ${companyId}`),
    safeCount(sql`SELECT COUNT(*) AS count FROM suppliers WHERE company_id = ${companyId}`),
    safeCount(sql`SELECT COUNT(*) AS count FROM fiscal_periods WHERE company_id = ${companyId}`),
    safeCount(sql`
      SELECT COUNT(*) AS count
      FROM gl_journal_entries
      WHERE company_id = ${companyId}
        AND source = 'opening_balance'
    `),
  ]);

  const completedTasks: string[] = [];
  if (company?.logo_data) completedTasks.push('company-logo');
  if (company?.registration_number) completedTasks.push('company-legal');
  if (company?.vat_number) completedTasks.push('vat-number');
  if (fiscalCount > 0) completedTasks.push('fiscal-year');
  if (openingCount > 0) completedTasks.push('opening-balances');
  if (bankAccountCount > 0) completedTasks.push('bank-account');
  if (bankTxCount > 0) completedTasks.push('bank-transactions');
  if (invoiceCount > 0) completedTasks.push('customer-invoices');
  if (customerCount > 0) completedTasks.push('customers');
  if (supplierCount > 0) completedTasks.push('suppliers');

  log.info('Setup guide status fetched', { companyId, completed: completedTasks.length }, 'setup-guide');
  return apiResponse.success(res, { completedTasks });
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
