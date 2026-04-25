/**
 * Default Accounts Configuration API
 * GET /api/accounting/default-accounts - Get default account mappings
 * POST /api/accounting/default-accounts - Save default account mappings
 * Sage equivalent: Accounts > Default Accounts
 *
 * Stores mappings in app_settings AND syncs is_system_account + account_subtype
 * on the selected GL accounts so systemAccountResolver picks them up.
 * All GL mutations run inside a single transaction so a partial failure
 * cannot leave system flags in a corrupt state.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql, withTransaction } from '@/lib/neon';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

const SETTINGS_KEY = 'accounting_default_accounts';

// Maps UI setting keys → system account subtypes used by systemAccountResolver.
const KEY_TO_SYSTEM_SUBTYPE: Record<string, string> = {
  sales_revenue:       'default_revenue',
  sales_vat_output:    'vat_output',
  accounts_receivable: 'receivable',
  cost_of_sales:       'default_expense',
  purchase_vat_input:  'vat_input',
  accounts_payable:    'payable',
  primary_bank:        'bank',
  retained_earnings:   'retained_earnings',
};

// Expected account_type for each subtype — guards against assigning an
// asset account as "revenue" or similar cross-category mistakes.
const SUBTYPE_EXPECTED_TYPE: Record<string, string> = {
  default_revenue:  'revenue',
  vat_output:       'liability',
  receivable:       'asset',
  default_expense:  'expense',
  vat_input:        'asset',
  payable:          'liability',
  bank:             'asset',
  retained_earnings:'equity',
};

type Row = Record<string, unknown>;

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

    // Validate account_type compatibility before touching the DB.
    for (const [uiKey, accountId] of Object.entries(mappings)) {
      const subtype = KEY_TO_SYSTEM_SUBTYPE[uiKey];
      const expectedType = subtype ? SUBTYPE_EXPECTED_TYPE[subtype] : null;
      if (!subtype || !accountId || !expectedType) continue;

      const rows = await sql`
        SELECT account_type FROM gl_accounts
        WHERE id = ${accountId as string}
          AND company_id = ${companyId}
        LIMIT 1
      ` as Row[];

      if (rows.length === 0) {
        return apiResponse.badRequest(res, `Account for '${uiKey}' not found`);
      }
      if (rows[0]!.account_type !== expectedType) {
        return apiResponse.badRequest(
          res,
          `Account for '${uiKey}' must be of type '${expectedType}' (got '${rows[0]!.account_type}')`,
        );
      }
    }

    try {
      await withTransaction(async (tx) => {
        // Persist the JSON mappings.
        await tx`
          INSERT INTO app_settings (key, value, company_id, updated_at)
          VALUES (${SETTINGS_KEY}, ${JSON.stringify(mappings)}::jsonb, ${companyId}, NOW())
          ON CONFLICT (key, company_id) DO UPDATE
          SET value = ${JSON.stringify(mappings)}::jsonb, updated_at = NOW()
        `;

        // Clear existing system designations for all managed subtypes so that
        // swapping an account doesn't leave stale system flags.
        const managedSubtypes = Object.values(KEY_TO_SYSTEM_SUBTYPE);
        for (const subtype of managedSubtypes) {
          await tx`
            UPDATE gl_accounts
            SET is_system_account = false
            WHERE company_id = ${companyId}
              AND account_subtype = ${subtype}
              AND is_system_account = true
          `;
        }

        // Mark the newly-selected accounts as system accounts.
        for (const [uiKey, accountId] of Object.entries(mappings)) {
          const subtype = KEY_TO_SYSTEM_SUBTYPE[uiKey];
          if (!subtype || !accountId) continue;
          await tx`
            UPDATE gl_accounts
            SET is_system_account = true,
                account_subtype   = ${subtype}
            WHERE id = ${accountId as string}
              AND company_id = ${companyId}
          `;
        }
      });

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
