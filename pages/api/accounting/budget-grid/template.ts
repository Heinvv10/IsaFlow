/**
 * Budget grid Excel template (budgets P2, spec §9.1)
 * GET ?version_id=<uuid>&grain=company|cc1|cc2|bu → .xlsx download
 * Sheet `Budget` (text YYYY-MM month headers; blank = not budgeted, 0 = budgeted zero), hidden
 * `_meta` tying the file to the version, year and grain, and `Instructions`. Upload it back through
 * POST budget-grid/import-preview. Another tenant's version id is a 404. Any member may download.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { isUuidParam } from '@/lib/validation';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { FiscalYearLabelUnknownError } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { loadBudgetTemplate, TEMPLATE_GRAINS, type TemplateGrain } from '@/modules/accounting/services/budgets/budgetTemplateXlsx';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const { version_id: versionId, grain: grainRaw } = req.query;
  if (!isUuidParam(versionId)) return apiResponse.badRequest(res, 'version_id must be a version id');
  const grain = (grainRaw === undefined || grainRaw === '' ? 'company' : grainRaw) as TemplateGrain;
  if (!TEMPLATE_GRAINS.includes(grain)) return apiResponse.badRequest(res, `grain must be one of ${TEMPLATE_GRAINS.join(', ')}`);

  try {
    const { file, fileName } = await loadBudgetTemplate(companyId, versionId, grain);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', file.byteLength);
    return res.status(200).send(file);
  } catch (err) {
    if (respondBudgetVersionError(res, err)) return;
    if (err instanceof FiscalYearLabelUnknownError) return apiResponse.notFound(res, 'Financial year', String(err.fiscalYear));
    throw err;
  }
}

export default withAuth(withErrorHandler(handler));
