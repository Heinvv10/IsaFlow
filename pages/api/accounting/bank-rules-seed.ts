/**
 * Bank Rules Seed API
 * POST /api/accounting/bank-rules-seed
 *   Seed categorisation rules from a Category Map (JSON array).
 *
 * Body: { entries: [{ originalCategory, standardCategory, glCode }] }
 * Answers { created, held, skipped, missingGlCodes?, message? }: under the
 * `bank_rule` switch with auto-post on, every seeded rule would post money, so
 * each is held as a pending creation for another member to approve (`held`).
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withRole, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { seedRules } from '@/modules/accounting/services/bank/bankRuleChangeControl';
import { pendingCreationPatterns } from '@/modules/accounting/services/bank/bankRuleChangeQueries';

const CategoryMapEntrySchema = z.object({
  originalCategory: z.string().min(1).max(500),
  standardCategory: z.string().max(500).optional().default(''),
  glCode: z.union([z.number(), z.string().max(50)]),
});
const BodySchema = z.object({
  entries: z.array(CategoryMapEntrySchema).min(1).max(2000),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const userId = req.user.id;
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    }
    const { entries } = parsed.data;

    // Fetch all GL accounts for this company in one query
     
    const glAccountRows = (await sql`
      SELECT id, account_code FROM gl_accounts WHERE company_id = ${companyId}
    `) as Record<string, unknown>[];
    const glAccountMap = new Map<string, string>(
      glAccountRows.map(r => [String(r.account_code), String(r.id)])
    );

    // Fetch all existing match_patterns for this company in one query
    const existingPatternRows = (await sql`
      SELECT LOWER(match_pattern) AS match_pattern FROM bank_categorisation_rules WHERE company_id = ${companyId}
    `) as Record<string, unknown>[];
    // …and those of creations held for approval, so a re-seed never proposes the same rule twice.
    const existingPatterns = new Set<string>([...existingPatternRows.map(r => String(r.match_pattern)),
      ...await pendingCreationPatterns(companyId)]);

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

    // One savepoint. A seeded rule that would post money (auto-post on, under
    // the `bank_rule` switch) is held as a pending creation instead of written.
    const { created, held } = await seedRules(companyId, toInsert, userId);

    log.info('Seeded bank categorisation rules', { created, held, skipped, missingGlCodes: missingGlCodes.length }, 'accounting');

    return apiResponse.success(res, {
      created,
      held,
      ...(held > 0 ? { message: `${held} rule${held === 1 ? '' : 's'} held for approval: auto-post is on, so each would post `
        + 'money. Another member must approve them under Pending changes on the Bank rules page.' } : {}),
      skipped,
      missingGlCodes: missingGlCodes.length > 0 ? missingGlCodes : undefined,
    });
  } catch (err) {
    // A database refusal (a SQLSTATE) is a fault, never an answer: its text is not for the caller.
    if (typeof (err as { code?: unknown }).code === 'string') throw err;
    const message = err instanceof Error ? err.message : 'Failed to seed bank rules';
    log.error('Failed to seed bank rules', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withAuth(withRole('admin')(withErrorHandler(withCsrf(handler))));
