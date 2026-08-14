/**
 * PATCH /api/accounting/assets/:assetId/gl-account
 *
 * Sets (or clears) the fixed-asset GL account an asset's cost sits in.
 *
 * This column existed and was read by the disposal journal, but nothing in the
 * product ever wrote it — so every asset had it NULL and disposal could not
 * name an account to credit. The alternative considered was to guess a
 * company-wide fixed-asset account, which silently books a vehicle's cost to
 * Equipment and breaks the per-class IAS 16 reconciliation with no visible
 * symptom. An explicit writer is the correct remedy.
 *
 * Body: { glAssetAccountId: string | null }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateAssetCostAccount } from '@/modules/accounting/services/gl/leafAccountValidator';

type Row = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'PATCH') return apiResponse.methodNotAllowed(res, req.method ?? '', ['PATCH']);

  const { companyId } = req;
  const { assetId } = req.query as { assetId: string };
  if (!assetId || !UUID_RE.test(assetId)) return apiResponse.notFound(res, 'Asset', assetId);

  const { glAssetAccountId } = (req.body ?? {}) as { glAssetAccountId?: string | null };

  // `null` clears the override so the asset falls back to its category.
  if (glAssetAccountId !== null && glAssetAccountId !== undefined) {
    if (!UUID_RE.test(glAssetAccountId)) {
      return apiResponse.badRequest(res, 'glAssetAccountId must be a UUID or null');
    }
    // Gate exactly what resolveAssetAccountId will later accept: a leaf,
    // active, fixed-asset-cost account in THIS company. Checking less would
    // store a value the disposal then refuses (a dead end for the operator) or
    // accept Bank / Accounts Receivable — both leaf assets — so the disposal
    // would credit Bank for the full cost with no cash movement, balancing
    // perfectly and surfacing nothing. gl_journal_lines has only a plain FK to
    // gl_accounts(id) with no composite company constraint, so the tenant check
    // has to happen here.
    const check = await validateAssetCostAccount(glAssetAccountId, companyId);
    if (!check.ok) return apiResponse.badRequest(res, `glAssetAccountId invalid: ${check.reason}`);
  }

  const updated = (await sql`
    UPDATE assets
    SET gl_asset_account_id = ${glAssetAccountId ?? null}::uuid,
        updated_at = NOW()
    WHERE id = ${assetId}::uuid AND company_id = ${companyId}::uuid
    RETURNING id, asset_number, gl_asset_account_id
  `) as Row[];

  if (updated.length === 0) return apiResponse.notFound(res, 'Asset', assetId);

  log.info('Asset GL account set', {
    assetId, companyId, glAssetAccountId: glAssetAccountId ?? null,
  }, 'accounting');

  return apiResponse.success(res, updated[0]);
}

export default withAuth(
  withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))),
);
