/**
 * Budget grid Excel template (budgets P2, spec §9.1)
 * GET ?version_id=<uuid>&grain=company|cc1|cc2|bu[&members=<uuid>,<uuid>,…] → .xlsx download
 * At a dimension grain the rows are the named members' (each the company's member of that kind),
 * else those of members holding amounts at that grain in the version or with prior-year activity.
 * Sheet `Budget` (text YYYY-MM month headers; blank = not budgeted, 0 = budgeted zero), hidden
 * `_meta` tying the file to the version, year and grain, hidden `_base` (the amounts as
 * downloaded, which the import diffs against, signed in `_meta`), and `Instructions`. Upload it
 * back through POST budget-grid/import-preview. A template of more rows than one save holds
 * (templateRowCap) is a 400 asking for fewer members. Another tenant's version id is a 404. Any
 * member may download; each user at most TEMPLATE_RATE downloads per 15 minutes across all their
 * companies (429).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rateLimit';
import { isUuidParam } from '@/lib/validation';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { FiscalYearLabelUnknownError } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { loadBudgetTemplate, TEMPLATE_GRAINS, type TemplateGrain } from '@/modules/accounting/services/budgets/budgetTemplateXlsx';

const TEMPLATE_RATE = 60;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const { version_id: versionId, grain: grainRaw, members: membersRaw } = req.query;
  if (!isUuidParam(versionId)) return apiResponse.badRequest(res, 'version_id must be a version id');
  const grain = (grainRaw === undefined || grainRaw === '' ? 'company' : grainRaw) as TemplateGrain;
  if (!TEMPLATE_GRAINS.includes(grain)) return apiResponse.badRequest(res, `grain must be one of ${TEMPLATE_GRAINS.join(', ')}`);
  let members: string[] | undefined;
  if (membersRaw !== undefined) {
    if (typeof membersRaw !== 'string') return apiResponse.badRequest(res, 'members must be one comma-separated list of member ids');
    // Ids compare lower-case everywhere (Postgres answers them so); an upper-case one is the same id.
    members = membersRaw.split(',').map((m) => m.trim().toLowerCase()).filter((m) => m !== '');
    if (members.length === 0 || !members.every((m) => isUuidParam(m))) return apiResponse.badRequest(res, 'members must be a comma-separated list of member ids');
  }
  if (!(await checkRateLimit(`budget-template:${userId}`, { max: TEMPLATE_RATE, windowSecs: 900 }))) {
    return apiResponse.tooManyRequests(res, 'Too many template downloads — wait a few minutes and try again.');
  }

  try {
    const { file, fileName } = await loadBudgetTemplate(companyId, versionId, grain, members);
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
