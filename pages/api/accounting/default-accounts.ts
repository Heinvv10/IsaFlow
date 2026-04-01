import { sql } from '@/lib/neon';
/**
 * Default Accounts Configuration API
 * GET /api/accounting/default-accounts - Get default account mappings
 * POST /api/accounting/default-accounts - Save default account mappings
 * Sage equivalent: Accounts > Default Accounts
 *
 * Stores mappings in gl_accounts metadata (JSON column) or a simple key-value approach.
 * Uses a settings row in a lightweight pattern: one JSON object stored per company.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';


const SETTINGS_KEY = 'accounting_default_accounts';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    try {
      // Try to read from app_settings table, fall back to empty
      let mappings: Record<string, string> = {};
      try {
        const [row] = await sql`
          SELECT value FROM app_settings WHERE key = ${SETTINGS_KEY} AND company_id = ${companyId}
        `;
        if (row?.value) {
          mappings = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
        }
      } catch {
        // app_settings table may not exist yet — return empty mappings
      }

      return apiResponse.success(res, { mappings });
    } catch (err) {
      log.error('Failed to fetch default accounts', { error: err, module: 'accounting' });
      return apiResponse.databaseError(res, err, 'Failed to fetch default accounts');
    }
  }

  if (req.method === 'POST') {
    const { mappings } = req.body;

    if (!mappings || typeof mappings !== 'object') {
      return apiResponse.validationError(res, { mappings: 'Object of key-value mappings required' });
    }

    try {
      // Upsert into app_settings
      await sql`
        INSERT INTO app_settings (key, value, company_id, updated_at)
        VALUES (${SETTINGS_KEY}, ${JSON.stringify(mappings)}::jsonb, ${companyId}, NOW())
        ON CONFLICT (key, company_id) DO UPDATE
        SET value = ${JSON.stringify(mappings)}::jsonb, updated_at = NOW()
      `;

      log.info('Default accounts saved', { keys: Object.keys(mappings), module: 'accounting' });
      return apiResponse.success(res, { saved: true });
    } catch (err) {
      log.error('accounting-default-accounts', { error: err instanceof Error ? err.message : String(err) });
      // If app_settings doesn't exist, create it
      if (String(err).includes('app_settings')) {
        try {
          await sql`
            CREATE TABLE IF NOT EXISTS app_settings (
              key TEXT NOT NULL,
              company_id UUID NOT NULL,
              value JSONB NOT NULL DEFAULT '{}',
              updated_at TIMESTAMPTZ DEFAULT NOW(),
              PRIMARY KEY (key, company_id)
            )
          `;
          await sql`
            INSERT INTO app_settings (key, value, company_id, updated_at)
            VALUES (${SETTINGS_KEY}, ${JSON.stringify(mappings)}::jsonb, ${companyId}, NOW())
          `;
          log.info('Created app_settings table and saved default accounts', { module: 'accounting' });
          return apiResponse.success(res, { saved: true });
        } catch (createErr) {
          log.error('Failed to create app_settings', { error: createErr, module: 'accounting' });
          return apiResponse.databaseError(res, createErr, 'Failed to save default accounts');
        }
      }
      log.error('Failed to save default accounts', { error: err, module: 'accounting' });
      return apiResponse.databaseError(res, err, 'Failed to save default accounts');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
