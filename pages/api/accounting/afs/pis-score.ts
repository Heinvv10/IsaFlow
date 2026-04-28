// pages/api/accounting/afs/pis-score.ts
// GET  — compute PIS score for the active company (standalone, no document needed)
//        Query: ?fiscal_year=2026 (optional, defaults to current year)
// PUT  — update company PIS input fields (employee_count, shareholder_count, etc.)

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { EntityTypeEnum } from '@/lib/schemas/afs';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { computePisBreakdown } from '@/modules/accounting/services/afs/pisCalculatorService';

type DbRow = Record<string, unknown>;

const PutPisSchema = z.object({
  employeeCountBeginning: z.number().int().min(0).max(1_000_000).nullable().optional(),
  employeeCountEnd: z.number().int().min(0).max(1_000_000).nullable().optional(),
  shareholderCount: z.number().int().min(0).max(1_000_000).nullable().optional(),
  allShareholdersAreDirectors: z.boolean().nullable().optional(),
  natureOfBusiness: z.string().max(2000).nullable().optional(),
  registeredAddress: z.string().max(2000).nullable().optional(),
  entityType: EntityTypeEnum.nullable().optional(),
}).strict();

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  // ── GET: compute PIS ────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const fiscalYear = Number(req.query.fiscal_year) || new Date().getFullYear();

    // Fetch company's financial year start month
    const companyRows = (await sql`
      SELECT COALESCE(financial_year_start, 3) AS fy_start
      FROM companies WHERE id = ${companyId}
    `) as DbRow[];

    const fyStartMonth = Number(companyRows[0]?.fy_start ?? 3);

    // Calculate fiscal year start/end dates
    const startYear = fyStartMonth > 1 ? fiscalYear - 1 : fiscalYear;
    const fiscalYearStart = `${startYear}-${String(fyStartMonth).padStart(2, '0')}-01`;

    let endMonth: number;
    let endYear: number;
    if (fyStartMonth === 1) {
      endMonth = 12;
      endYear = fiscalYear;
    } else {
      endMonth = fyStartMonth - 1;
      endYear = fiscalYear;
    }
    const lastDay = new Date(endYear, endMonth, 0).getDate();
    const fiscalYearEnd = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const breakdown = await computePisBreakdown(companyId, fiscalYearStart, fiscalYearEnd);

    return apiResponse.success(res, {
      fiscalYear,
      fiscalYearStart,
      fiscalYearEnd,
      ...breakdown,
    });
  }

  // ── PUT: update PIS input fields ────────────────────────────────────────
  if (req.method === 'PUT') {
    const parsed = PutPisSchema.safeParse(req.body ?? {});
    if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
    const {
      employeeCountBeginning,
      employeeCountEnd,
      shareholderCount,
      allShareholdersAreDirectors,
      natureOfBusiness,
      registeredAddress,
      entityType,
    } = parsed.data;

    await sql`
      UPDATE companies SET
        employee_count_beginning = COALESCE(${employeeCountBeginning ?? null}::INT, employee_count_beginning),
        employee_count_end = COALESCE(${employeeCountEnd ?? null}::INT, employee_count_end),
        shareholder_count = COALESCE(${shareholderCount ?? null}::INT, shareholder_count),
        all_shareholders_are_directors = COALESCE(${allShareholdersAreDirectors ?? null}::BOOLEAN, all_shareholders_are_directors),
        nature_of_business = COALESCE(${natureOfBusiness ?? null}::TEXT, nature_of_business),
        registered_address = COALESCE(${registeredAddress ?? null}::TEXT, registered_address),
        entity_type = COALESCE(${entityType ?? null}::VARCHAR, entity_type),
        updated_at = NOW()
      WHERE id = ${companyId}
    `;

    return apiResponse.success(res, { updated: true }, 'PIS input fields updated');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
