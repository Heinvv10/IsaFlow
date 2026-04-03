/**
 * GET /api/accounting/setup-guide
 * Returns auto-detected completed task IDs based on company data.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
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

  const { companyId } = req as CompanyApiRequest;

  try {
    const [
      companyRows,
      bankAccountRows,
      bankTxRows,
      invoiceRows,
      customerRows,
      supplierRows,
      fiscalRows,
      openingRows,
    ] = await Promise.all([
      sql`
        SELECT logo_data, registration_number, vat_number
        FROM companies
        WHERE id = ${companyId}
        LIMIT 1
      `,
      sql`
        SELECT COUNT(*) AS count
        FROM bank_accounts
        WHERE company_id = ${companyId}
      `,
      sql`
        SELECT COUNT(*) AS count
        FROM bank_transactions
        WHERE company_id = ${companyId}
      `,
      sql`
        SELECT COUNT(*) AS count
        FROM customer_invoices
        WHERE company_id = ${companyId}
      `,
      sql`
        SELECT COUNT(*) AS count
        FROM customers
        WHERE company_id = ${companyId}
      `,
      sql`
        SELECT COUNT(*) AS count
        FROM suppliers
        WHERE company_id = ${companyId}
      `,
      sql`
        SELECT COUNT(*) AS count
        FROM fiscal_periods
        WHERE company_id = ${companyId}
      `,
      sql`
        SELECT COUNT(*) AS count
        FROM gl_journal_entries
        WHERE company_id = ${companyId}
          AND source = 'opening_balance'
      `,
    ]);

    const company = (companyRows as CompanyRow[])[0];
    const bankAccountCount = Number((bankAccountRows as CountRow[])[0]?.count ?? 0);
    const bankTxCount = Number((bankTxRows as CountRow[])[0]?.count ?? 0);
    const invoiceCount = Number((invoiceRows as CountRow[])[0]?.count ?? 0);
    const customerCount = Number((customerRows as CountRow[])[0]?.count ?? 0);
    const supplierCount = Number((supplierRows as CountRow[])[0]?.count ?? 0);
    const fiscalCount = Number((fiscalRows as CountRow[])[0]?.count ?? 0);
    const openingCount = Number((openingRows as CountRow[])[0]?.count ?? 0);

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
  } catch (err) {
    log.error('Failed to fetch setup guide status', { error: err }, 'setup-guide');
    return apiResponse.badRequest(res, 'Failed to fetch setup guide status');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
