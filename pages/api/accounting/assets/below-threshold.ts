/**
 * GET  /api/accounting/assets/below-threshold — list assets flagged below cap threshold
 * POST /api/accounting/assets/below-threshold — expense an asset below threshold to GL
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { checkCapitalizationThreshold } from '@/modules/accounting/services/items/farDepreciationService';
import { postCapitalizationExpenseToGL } from '@/modules/accounting/services/gl/glCrossModuleHooks';

type Row = Record<string, unknown>;

/** Postgres `lock_not_available` — the 5s `lock_timeout` elapsed on FOR UPDATE. */
const LOCK_NOT_AVAILABLE = '55P03';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = (req as unknown as CompanyAuthedRequest).companyId;
  const userId = String(req.user.id);

  if (req.method === 'GET') {
    // Return all assets flagged as below threshold (or auto-detect from category threshold)
    const rows = (await sql`
      SELECT
        a.id, a.asset_number, a.name, a.purchase_price AS cost,
        a.below_threshold, a.status, a.created_at,
        c.name AS category_name,
        COALESCE(c.capitalization_threshold, 5000) AS threshold
      FROM assets a
      LEFT JOIN asset_categories c ON c.id = a.category_id
      WHERE a.company_id = ${companyId}::UUID
        AND a.purchase_price < COALESCE(c.capitalization_threshold, 5000)
        AND a.status NOT IN ('disposed', 'written_off')
      ORDER BY a.created_at DESC
    `) as Row[];

    // `expensed` comes from the real a.below_threshold column. Without it every
    // row looks identical to the page, which then offers "Post to GL" on an asset
    // the POST branch now refuses with 409 — a dead button with no explanation.
    return apiResponse.success(res, rows.map(r => ({
      ...r,
      belowThreshold: true,
      expensed: r.below_threshold === true,
      suggestedTreatment: 'expense',
    })));
  }

  if (req.method === 'POST') {
    // Expense a specific below-threshold asset to GL
    const { assetId } = req.body as { assetId?: string };
    if (!assetId) return apiResponse.badRequest(res, 'assetId is required');

    const client = als.getStore()?.client;
    if (!client) {
      // Outside a request transaction FOR UPDATE releases at once and locks
      // nothing. Fail loudly rather than pretend the repeat is serialised.
      throw new Error('below-threshold expense requires a request transaction (withAuth).');
    }

    // Bound the wait like creditNoteLock/bankTxLock do; FOR UPDATE otherwise
    // queues forever behind whoever holds the row.
    await client.query("SET LOCAL lock_timeout = '5s'");
    let assetRows: Row[];
    try {
      // FOR UPDATE: the already-expensed check below is only meaningful while the
      // row is held. postCapitalizationExpenseToGL sets below_threshold = true only
      // AFTER posting, so two concurrent requests would otherwise both read false
      // and both post an expense journal for the same asset. OF a: the LEFT JOIN
      // must not be locked (and asset_categories is a shared reference table).
      assetRows = (await sql`
        SELECT a.id, a.purchase_price AS cost, a.status, a.below_threshold,
               COALESCE(c.capitalization_threshold, 5000) AS threshold
        FROM assets a
        LEFT JOIN asset_categories c ON c.id = a.category_id
        WHERE a.id = ${assetId}::UUID AND a.company_id = ${companyId}::UUID
        FOR UPDATE OF a
      `) as Row[];
      // Success path only — after a lock timeout the transaction is aborted and
      // this statement would throw 25P02 over the typed error. See creditNoteLock.
      await client.query('SET LOCAL lock_timeout = DEFAULT');
    } catch (err) {
      if ((err as { code?: string }).code === LOCK_NOT_AVAILABLE) {
        return apiResponse.conflict(res, 'Asset is being expensed by another request — retry in a moment.');
      }
      throw err;
    }

    if (!assetRows[0]) return apiResponse.notFound(res, 'Asset not found');

    const asset = assetRows[0];
    // A repeat is a state conflict, not a malformed request: 409 lets a caller
    // tell it apart from the 400s this route returns for bad input.
    if (asset.below_threshold === true) {
      return apiResponse.conflict(res, 'Asset has already been expensed');
    }
    // A disposal already recognised the gain or loss and cleared the asset;
    // expensing afterwards recognises the cost twice. dispose.ts blocks the
    // mirror case, and the GET list above already excludes these.
    if (asset.status === 'disposed' || asset.status === 'written_off') {
      return apiResponse.badRequest(res, `Asset is ${String(asset.status)} and cannot be expensed`);
    }

    const cost = Number(asset.cost);
    const threshold = Number(asset.threshold);

    const check = checkCapitalizationThreshold({ cost, threshold });
    if (!check.belowThreshold) {
      return apiResponse.badRequest(res, `Asset cost ${cost} is at or above threshold ${threshold}`);
    }

    // Pre-check the period the hook will post into, the way dispose.ts pre-checks
    // its own posting precondition. Catching ClosedFiscalPeriodError afterwards
    // would be worse than the 500 it replaces: the hook has already created the
    // DRAFT journal by then, and withAuth COMMITs on a 4xx, so the 400 would
    // leave an orphan draft behind. No row covering today is left alone — the
    // posting service creates one.
    const today = new Date().toISOString().slice(0, 10);
    const periodRows = (await sql`
      SELECT status FROM fiscal_periods
      WHERE company_id = ${companyId}::UUID
        AND ${today}::DATE BETWEEN start_date AND end_date
      ORDER BY start_date DESC
      LIMIT 1
    `) as Row[];
    if (periodRows[0] && periodRows[0].status !== 'open') {
      return apiResponse.badRequest(
        res,
        `The fiscal period covering ${today} is ${String(periodRows[0].status)}. Reopen it, then retry.`,
      );
    }

    const entryId = await postCapitalizationExpenseToGL(companyId, assetId, cost, userId);
    return apiResponse.success(res, { assetId, cost, threshold, journalEntryId: entryId });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

// withWriteAccess (owner/admin/manager) was missing: the POST branch posts a GL
// journal, so a company `viewer` could write to the ledger through this route.
export default withAuth(
  withCsrf(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))),
);
