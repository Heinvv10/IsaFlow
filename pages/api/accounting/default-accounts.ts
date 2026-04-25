import { sql } from '@/lib/neon';
/**
 * Default Accounts Configuration API
 * GET /api/accounting/default-accounts - Get default account mappings
 * POST /api/accounting/default-accounts - Save default account mappings
 * Sage equivalent: Accounts > Default Accounts
 *
 * Stores mappings in app_settings AND syncs is_system_account + account_subtype
 * on the selected GL accounts so systemAccountResolver picks them up.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

const SETTINGS_KEY = 'accounting_default_accounts';

// Maps UI setting keys → system account subtypes used by systemAccountResolver.
const KEY_TO_SYSTEM_SUBTYPE: Record<string, string> = {
  sales_revenue:      'default_revenue',
  sales_vat_output:   'vat_output',
  accounts_receivable:'receivable',
  cost_of_sales:      'default_expense',
  purchase_vat_input: 'vat_input',
  accounts_payable:   'payable',
  primary_bank:       'bank',
  retained_earnings:  'retained_earnings',
};

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    try {
      let mappings: Record<string, string> = {};
      const [row] = await sql`
        SELECT value FROM app_settings WHERE key = ${SETTINGS_KEY} AND company_id = ${companyId}
      `;
      if (row?.value) {
        mappings = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      }
      return apiResponse.success(res, { mappings });
    } catch (err) {
      log.error('Failed to fetch default accounts', { error: err instanceof Error ? err.message : String(err), module: 'accounting' });
      return apiResponse.databaseError(res, err, 'Failed to fetch default accounts');
    }
  }

  if (req.method === 'POST') {
    const { mappings } = req.body;

    if (!mappings || typeof mappings !== 'object') {
      return apiResponse.validationError(res, { mappings: 'Object of key-value mappings required' });
    }

    try {
      // Persist the JSON mappings.
      await sql`
        INSERT INTO app_settings (key, value, company_id, updated_at)
        VALUES (${SETTINGS_KEY}, ${JSON.stringify(mappings)}::jsonb, ${companyId}, NOW())
        ON CONFLICT (key, company_id) DO UPDATE
        SET value = ${JSON.stringify(mappings)}::jsonb, updated_at = NOW()
      `;

      // Sync system account flags so systemAccountResolver works correctly.
      // First: clear all existing system designations for the subtypes we manage,
      // so swapping an account doesn't leave two accounts with the same subtype.
      const managedSubtypes = Object.values(KEY_TO_SYSTEM_SUBTYPE);
      for (const subtype of managedSubtypes) {
        await sql`
          UPDATE gl_accounts
          SET is_system_account = false
          WHERE company_id = ${companyId}
            AND account_subtype = ${subtype}
            AND is_system_account = true
        `;
      }

      // Then: mark the newly-selected accounts as system accounts with the right subtype.
      for (const [uiKey, accountId] of Object.entries(mappings)) {
        const subtype = KEY_TO_SYSTEM_SUBTYPE[uiKey];
        if (!subtype || !accountId) continue;
        await sql`
          UPDATE gl_accounts
          SET is_system_account = true,
              account_subtype   = ${subtype}
          WHERE id = ${accountId}
            AND company_id = ${companyId}
        `;
      }

      clearSystemAccountCache(companyId);
      log.info('Default accounts saved and system flags synced', { keys: Object.keys(mappings), module: 'accounting' });
      return apiResponse.success(res, { saved: true });
    } catch (err) {
      log.error('Failed to save default accounts', { error: err instanceof Error ? err.message : String(err), module: 'accounting' });
      return apiResponse.databaseError(res, err, 'Failed to save default accounts');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}


export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
