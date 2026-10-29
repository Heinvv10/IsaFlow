/**
 * Budget grid read model (budgets P2)
 * GET ?version_id=<uuid>   — that version
 * GET ?fiscal_year=2027    — the year's primary version, else its newest; `version: null` when it has none
 * GET …&cells_only=1       — just the cells and the token (the compare-version fetch)
 * Another tenant's version id is a 404. Any member may read (viewers included).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { isUuidParam } from '@/lib/validation';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { parseYearLabel } from '@/modules/accounting/services/core/budgetMonths';
import { FiscalYearLabelUnknownError } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { loadGridCells, loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import type { GridSelector } from '@/modules/accounting/services/budgets/gridReadTypes';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const { version_id: versionId, fiscal_year: fiscalYearRaw, cells_only: cellsOnly } = req.query;

  const sel: GridSelector = {};
  if (versionId !== undefined && versionId !== '') {
    if (!isUuidParam(versionId)) return apiResponse.badRequest(res, 'version_id must be a version id');
    sel.versionId = versionId;
  } else {
    const label = parseYearLabel(fiscalYearRaw);
    if (label === null) return apiResponse.badRequest(res, 'Pass version_id, or fiscal_year as a year label such as 2027');
    sel.fiscalYear = label;
  }

  try {
    if (cellsOnly === '1') return apiResponse.success(res, await loadGridCells(companyId, sel));
    return apiResponse.success(res, await loadGridReadModel(companyId, sel));
  } catch (err) {
    if (respondBudgetVersionError(res, err)) return;
    if (err instanceof FiscalYearLabelUnknownError) return apiResponse.notFound(res, 'Financial year', String(err.fiscalYear));
    throw err;
  }
}

export default withAuth(withErrorHandler(handler));
