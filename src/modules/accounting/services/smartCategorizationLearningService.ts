/**
 * Smart Categorization Learning Service
 * Pattern learning from user allocations — split from smartCategorizationMatchingService.ts.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { extractLearningPattern } from './smartCategorizationMatchingService';

type Row = Record<string, unknown>;

export async function learnFromAllocation(
  companyId: string,
  txId: string,
  glAccountId: string,
  category: string,
  vatCode?: string,
): Promise<void> {
  try {
    const txRows = (await sql`
      SELECT description FROM bank_transactions
      WHERE id = ${txId}::UUID AND company_id = ${companyId}::uuid
    `) as Row[];

    const firstTx = txRows[0];
    if (!firstTx) return;

    const description = String(firstTx.description || '').trim();
    if (description.length < 3) return;

    const pattern = extractLearningPattern(description);
    if (!pattern || pattern.length < 3) return;

    const existing = (await sql`
      SELECT id, usage_count FROM categorization_patterns
      WHERE UPPER(pattern) = ${pattern.toUpperCase()}
        AND source = 'learned'
        AND company_id = ${companyId}::uuid
      LIMIT 1
    `) as Row[];

    const existingRow = existing[0];
    if (existingRow) {
      const newCount = Number(existingRow.usage_count) + 1;
      const newConfidence = Math.min(0.95, 0.60 + newCount * 0.05);
      await sql`
        UPDATE categorization_patterns
        SET gl_account_id = ${glAccountId}::UUID,
            category = ${category},
            vat_code = ${vatCode || 'standard'},
            usage_count = ${newCount},
            confidence = ${newConfidence},
            last_used_at = NOW()
        WHERE id = ${existingRow.id}::UUID
      `;
    } else {
      // Check if company_id column exists on categorization_patterns
      // (older DBs may not have it — use a safe INSERT)
      try {
        await sql`
          INSERT INTO categorization_patterns
            (pattern, match_type, gl_account_id, category, vat_code, confidence, usage_count, last_used_at, source, company_id)
          VALUES
            (${pattern}, 'contains', ${glAccountId}::UUID, ${category}, ${vatCode || 'standard'}, 0.65, 1, NOW(), 'learned', ${companyId}::uuid)
        `;
      } catch {
        // Fallback without company_id if column doesn't exist
        await sql`
          INSERT INTO categorization_patterns
            (pattern, match_type, gl_account_id, category, vat_code, confidence, usage_count, last_used_at, source)
          VALUES
            (${pattern}, 'contains', ${glAccountId}::UUID, ${category}, ${vatCode || 'standard'}, 0.65, 1, NOW(), 'learned')
        `;
      }
    }

    log.info('Learned categorization pattern', { pattern, category, glAccountId, companyId }, 'accounting');
  } catch (err) {
    log.error('Failed to learn from allocation', { txId, error: err }, 'accounting');
    // Non-critical: don't throw
  }
}
