// pages/api/accounting/afs/report-templates.ts
// GET — retrieve rendered report template text for a given report type
// Query: ?type=compilation|accounting_officer|review|audit&entity_type=pty|cc|trust&framework=ifrs_smes|full_ifrs

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import {
  getPractitionerReport,
  getDirectorResponsibilityStatement,
  getDirectorsReport,
  getGeneralInformation,
  type ReportType,
  type ReportTemplateContext,
} from '@/modules/accounting/services/afs/reportTemplates';

type DbRow = Record<string, unknown>;

const VALID_REPORT_TYPES = new Set(['compilation', 'accounting_officer', 'review', 'audit']);
const VALID_ENTITY_TYPES = new Set(['pty', 'cc', 'trust']);
const VALID_FRAMEWORKS = new Set(['ifrs_smes', 'full_ifrs']);

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);

  const { companyId } = req;
  const reportType = req.query.type as string | undefined;

  if (!reportType || !VALID_REPORT_TYPES.has(reportType)) {
    return apiResponse.badRequest(res, `type must be one of: ${[...VALID_REPORT_TYPES].join(', ')}`);
  }

  // Fetch company details for template context
  const rows = (await sql`
    SELECT
      c.name AS company_name,
      c.registration_number,
      c.default_currency,
      c.vat_system_type,
      c.financial_year_start_month,
      c.registered_address,
      c.nature_of_business
    FROM companies c
    WHERE c.id = ${companyId}
  `) as DbRow[];

  const company = rows[0];
  if (!company) return apiResponse.notFound(res, 'Company not found');

  // Entity type and framework from query params, with defaults
  const entityType = (req.query.entity_type as string) ?? 'pty';
  const framework = (req.query.framework as string) ?? 'ifrs_smes';

  if (!VALID_ENTITY_TYPES.has(entityType)) {
    return apiResponse.badRequest(res, `entity_type must be one of: ${[...VALID_ENTITY_TYPES].join(', ')}`);
  }
  if (!VALID_FRAMEWORKS.has(framework)) {
    return apiResponse.badRequest(res, `framework must be one of: ${[...VALID_FRAMEWORKS].join(', ')}`);
  }

  const periodEnd = req.query.period_end as string | undefined;

  const ctx: ReportTemplateContext = {
    companyName: String(company.company_name ?? ''),
    registrationNumber: company.registration_number ? String(company.registration_number) : null,
    periodEnd: periodEnd ?? '{periodEnd}',
    periodStart: '{periodStart}',
    framework: framework as ReportTemplateContext['framework'],
    entityType: entityType as ReportTemplateContext['entityType'],
    practitionerName: req.query.practitioner as string | undefined,
    practitionerCity: req.query.city as string | undefined,
    reportDate: req.query.report_date as string | undefined,
    registeredAddress: company.registered_address ? String(company.registered_address) : undefined,
    natureOfBusiness: company.nature_of_business ? String(company.nature_of_business) : undefined,
  };

  const practitionerReport = getPractitionerReport(reportType as ReportType, ctx);
  const directorsResponsibility = getDirectorResponsibilityStatement(ctx);
  const directorsReport = getDirectorsReport(ctx);
  const generalInformation = getGeneralInformation(ctx);

  return apiResponse.success(res, {
    reportType,
    entityType,
    framework,
    templates: {
      practitionerReport: practitionerReport.join('\n'),
      directorsResponsibility: directorsResponsibility.join('\n'),
      directorsReport: directorsReport.join('\n'),
      generalInformation: generalInformation.join('\n'),
    },
  });
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
