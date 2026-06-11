/**
 * /api/payroll/parallel-run/imports
 *
 * GET  — list external payslip imports for the company.
 * POST — create an import from raw CSV text:
 *        { csvText, periodMonth, periodYear, source?, fileName? }
 *        Rejects (400) when the CSV has file-level errors or zero valid rows;
 *        row-level warnings are returned alongside the created import.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { log } from '@/lib/logger';
import { parseExternalPayslipCsv } from '@/modules/accounting/services/payroll/payrollExternalCsvParser';
import {
  createExternalImport,
  listExternalImports,
} from '@/modules/accounting/services/payroll/payrollExternalImportService';

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
};

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const imports = await listExternalImports(companyId);
    return apiResponse.success(res, { imports });
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const csvText = typeof body.csvText === 'string' ? body.csvText : '';
    const periodMonth = Number(body.periodMonth);
    const periodYear = Number(body.periodYear);
    const source = typeof body.source === 'string' && body.source.trim() !== ''
      ? body.source.trim().slice(0, 100)
      : 'external';
    const fileName = typeof body.fileName === 'string' && body.fileName.trim() !== ''
      ? body.fileName.trim().slice(0, 255)
      : null;

    if (csvText.trim() === '') {
      return apiResponse.badRequest(res, 'csvText is required');
    }
    if (!Number.isInteger(periodMonth) || periodMonth < 1 || periodMonth > 12) {
      return apiResponse.badRequest(res, 'periodMonth must be 1–12');
    }
    if (!Number.isInteger(periodYear) || periodYear < 2020 || periodYear > 2100) {
      return apiResponse.badRequest(res, 'periodYear must be 2020–2100');
    }

    const parsed = parseExternalPayslipCsv(csvText);
    if (parsed.rows.length === 0) {
      return apiResponse.badRequest(
        res,
        `CSV has no valid payslip rows: ${parsed.errors.map((e) => `line ${e.line}: ${e.message}`).join('; ') || 'no data rows'}`,
      );
    }

    const created = await createExternalImport(companyId, {
      periodMonth,
      periodYear,
      source,
      fileName,
      componentsPresent: parsed.componentsPresent,
      rows: parsed.rows,
      createdBy: (req as CompanyAuthedRequest).user?.id ?? null,
    });
    log.info('External payslip import created', {
      companyId, importId: created.id, periodMonth, periodYear,
      payslipCount: parsed.rows.length, rowErrors: parsed.errors.length,
    }, 'parallelRunImports');
    return apiResponse.created(res, { import: created, rowErrors: parsed.errors });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
