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
import { sql, transaction } from '@/lib/neon';
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

    // Fetch all GL accounts for this company in one query
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const glAccountRows = (await sql`
      SELECT id, account_code FROM gl_accounts WHERE company_id = ${companyId}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    `) as any[];
    const glAccountMap = new Map<string, string>(
      glAccountRows.map((r: { id: string; account_code: string }) => [String(r.account_code), String(r.id)])
    );

    // Fetch all existing match_patterns for this company in one query
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existingPatternRows = (await sql`
      SELECT LOWER(match_pattern) AS match_pattern FROM bank_categorisation_rules WHERE company_id = ${companyId}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    `) as any[];
    const existingPatterns = new Set<string>(existingPatternRows.map((r: { match_pattern: string }) => String(r.match_pattern)));

    let skipped = 0;
    const missingGlCodes: (number | string)[] = [];

    interface RuleRow {
      ruleName: string;
      pattern: string;
      glAccountId: string;
    }
    const toInsert: RuleRow[] = [];

    for (const entry of entries) {
      const pattern = String(entry.originalCategory || '').toLowerCase().trim();
      if (!pattern) { skipped++; continue; }

      const glCode = String(entry.glCode).trim();
      if (!glCode) { skipped++; continue; }

      const glAccountId = glAccountMap.get(glCode);
      if (!glAccountId) {
        missingGlCodes.push(entry.glCode);
        skipped++;
        continue;
      }

      if (existingPatterns.has(pattern)) {
        skipped++;
        continue;
      }

      toInsert.push({
        ruleName: String(entry.standardCategory || entry.originalCategory).trim(),
        pattern,
        glAccountId,
      });
    }

    // Batch INSERT all new rules in a single transaction
    if (toInsert.length > 0) {
      await transaction((txSql) =>
        toInsert.map((r) =>
          txSql`
            INSERT INTO bank_categorisation_rules (
              rule_name, match_field, match_type, match_pattern,
              gl_account_id, auto_create_entry, priority, created_by,
              company_id
            ) VALUES (
              ${r.ruleName}, 'description', 'contains', ${r.pattern},
              ${r.glAccountId}::UUID, false, 100, ${userId},
              ${companyId}
            )
          `
        )
      );
    }

    const created = toInsert.length;

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
export default withCompany(withRole('admin')(withErrorHandler(handler)));
