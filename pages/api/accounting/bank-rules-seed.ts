/**
 * Bank Rules Seed API
 * POST /api/accounting/bank-rules-seed
 *   Seed categorisation rules from a Category Map (JSON array).
 *
 * Body: { entries: [{ originalCategory, standardCategory, glCode }] }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, withRole, type AuthenticatedNextApiRequest, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

interface CategoryMapEntry {
  originalCategory: string;
  standardCategory: string;
  glCode: number | string;
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    const userId = req.user.id;
    const { entries } = req.body as { entries: CategoryMapEntry[] };

    if (!Array.isArray(entries) || entries.length === 0) {
      return apiResponse.badRequest(res, 'entries array is required');
    }

    let created = 0;
    let skipped = 0;
    const missingGlCodes: (number | string)[] = [];

    for (const entry of entries) {
      const pattern = String(entry.originalCategory || '').toLowerCase().trim();
      if (!pattern) { skipped++; continue; }

      const glCode = String(entry.glCode).trim();
      if (!glCode) { skipped++; continue; }

      // Look up GL account by account_code
      const glRows = (await sql`
        SELECT id FROM gl_accounts WHERE account_code = ${glCode} AND company_id = ${companyId} LIMIT 1
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      `) as any[];

      if (glRows.length === 0) {
        missingGlCodes.push(entry.glCode);
        skipped++;
        continue;
      }

      const glAccountId = String(glRows[0].id);
      const ruleName = String(entry.standardCategory || entry.originalCategory).trim();

      // UPSERT — skip if match_pattern already exists
      const existing = (await sql`
        SELECT id FROM bank_categorisation_rules
        WHERE LOWER(match_pattern) = ${pattern} AND company_id = ${companyId} LIMIT 1
      `) as any[];

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      await sql`
        INSERT INTO bank_categorisation_rules (
          rule_name, match_field, match_type, match_pattern,
          gl_account_id, auto_create_entry, priority, created_by,
          company_id
        ) VALUES (
          ${ruleName}, 'description', 'contains', ${pattern},
          ${glAccountId}::UUID, false, 100, ${userId},
          ${companyId}
        )
      `;
      created++;
    }

    log.info('Seeded bank categorisation rules', { created, skipped, missingGlCodes: missingGlCodes.length }, 'accounting');

    return apiResponse.success(res, {
      created,
      skipped,
      missingGlCodes: missingGlCodes.length > 0 ? missingGlCodes : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to seed bank rules';
    log.error('Failed to seed bank rules', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withRole('admin')(withErrorHandler(handler as any)));
