/**
 * Smart Categorization Matching Service
 * Three-strategy matching: rules, patterns, historical learning.
 *
 * All DB-fetching functions (matchAgainstRules, matchAgainstPatterns, matchFromHistory)
 * have been replaced with in-memory equivalents that accept pre-loaded data.
 * This allows callers to cache the data once per bulk operation.
 *
 * Security: all DB queries must be scoped to companyId — enforced by callers.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface CategorizationResult {
  glAccountId?: string;
  glAccountCode?: string;
  glAccountName?: string;
  category?: string;
  vatCode?: string;
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  matchSource: 'rule' | 'pattern' | 'historical';
  matchDetail?: string;
}

// Pre-loaded row types used by callers
export type CachedRule    = Row;
export type CachedPattern = Row;

export function toConfidenceLevel(score: number): ConfidenceLevel {
  if (score >= 0.85) return 'HIGH';
  if (score >= 0.60) return 'MEDIUM';
  return 'LOW';
}

// ── Strategy 1: In-memory rule matching (caller pre-loads rules) ──────────────

export function matchAgainstRulesInMemory(
  description: string,
  reference: string,
  rules: CachedRule[]
): CategorizationResult | null {
  for (const rule of rules) {
    const pattern   = String(rule.match_pattern).toUpperCase();
    const matchType = String(rule.match_type);
    const matchField = String(rule.match_field ?? 'description');

    const targets: string[] = [];
    if (matchField === 'description' || matchField === 'both') targets.push(description);
    if (matchField === 'reference'   || matchField === 'both') targets.push(reference);

    const matched = targets.some(target => {
      switch (matchType) {
        case 'contains':    return target.includes(pattern);
        case 'starts_with': return target.startsWith(pattern);
        case 'ends_with':   return target.endsWith(pattern);
        case 'exact':       return target === pattern;
        default:            return target.includes(pattern);
      }
    });

    if (matched) {
      return {
        glAccountId:   rule.gl_account_id   ? String(rule.gl_account_id)   : undefined,
        glAccountCode: rule.gl_account_code ? String(rule.gl_account_code) : undefined,
        glAccountName: rule.gl_account_name ? String(rule.gl_account_name) : undefined,
        category:   String(rule.rule_name),
        vatCode:    String(rule.vat_code || 'none'),
        confidence: 0.95,
        confidenceLevel: 'HIGH',
        matchSource: 'rule',
        matchDetail: `Rule: ${rule.rule_name} (${matchType} "${rule.match_pattern}")`,
      };
    }
  }
  return null;
}

// ── Strategy 2: In-memory pattern matching (caller pre-loads patterns) ────────

export function matchAgainstPatternsInMemory(
  description: string,
  reference: string,
  patterns: CachedPattern[]
): CategorizationResult | null {
  const combined = `${description} ${reference}`;

  for (const p of patterns) {
    const pat       = String(p.pattern).toUpperCase();
    const matchType = String(p.match_type ?? 'contains');

    let matched = false;
    switch (matchType) {
      case 'contains':
        matched = combined.includes(pat);
        break;
      case 'starts_with':
        matched = description.startsWith(pat) || reference.startsWith(pat);
        break;
      case 'regex':
        try {
          const re = new RegExp(String(p.pattern), 'i');
          matched = re.test(description) || re.test(reference);
        } catch {
          matched = false;
        }
        break;
      default:
        matched = combined.includes(pat);
    }

    if (matched) {
      const confidence = Number(p.confidence) || 0.80;

      // Fire-and-forget usage increment (non-blocking)
      sql`
        UPDATE categorization_patterns
        SET usage_count = usage_count + 1, last_used_at = NOW()
        WHERE id = ${p.id}::UUID
      `.catch((err) =>
        log.warn('Failed to update pattern usage count', { patternId: p.id, error: String(err) }, 'categorization')
      );

      return {
        glAccountId:   p.gl_account_id   ? String(p.gl_account_id)   : undefined,
        glAccountCode: p.gl_account_code ? String(p.gl_account_code) : undefined,
        glAccountName: p.gl_account_name ? String(p.gl_account_name) : undefined,
        category: p.category ? String(p.category) : undefined,
        vatCode:  String(p.vat_code || 'standard'),
        confidence,
        confidenceLevel: toConfidenceLevel(confidence),
        matchSource: 'pattern',
        matchDetail: `Pattern: "${p.pattern}" (${p.source})`,
      };
    }
  }
  return null;
}

// ── Strategy 3: Bulk historical lookup (single query, company-scoped) ─────────

export async function matchFromHistoryBulk(
  companyId: string,
  transactions: Array<{ txId: string; description: string; amount: number }>
): Promise<Map<string, CategorizationResult | null>> {
  const result = new Map<string, CategorizationResult | null>(
    transactions.map(t => [t.txId, null])
  );

  if (transactions.length === 0) return result;

  // Build unique word sets for all descriptions
  const noiseWords = new Set([
    'THE', 'AND', 'FOR', 'FROM', 'WITH', 'PAYMENT', 'TRANSFER',
    'DEBIT', 'CREDIT', 'ORDER', 'REF', 'POS', 'PURCHASE', 'CARD',
  ]);

  // For efficiency: run one query per unique "first word" cluster
  // Group transactions by their primary keyword
  const groups = new Map<string, Array<{ txId: string; description: string; amount: number }>>();

  for (const tx of transactions) {
    const words = tx.description
      .split(/[\s/\\,.-]+/)
      .filter(w => w.length >= 3 && !noiseWords.has(w) && !/^\d+$/.test(w));
    const key = words.slice(0, 2).join(' ');
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(tx);
  }

  // Query each group — all within companyId scope
  await Promise.all([...groups.entries()].map(async ([key, txGroup]) => {
    const likePattern = `%${key.replace(/ /g, '%')}%`;
    try {
      const rows = (await sql`
        SELECT
          bt.suggested_gl_account_id,
          bt.suggested_category,
          bt.suggested_vat_code,
          ga.account_code AS gl_account_code,
          ga.account_name AS gl_account_name,
          COUNT(*) AS match_count
        FROM bank_transactions bt
        LEFT JOIN gl_accounts ga ON ga.id = bt.suggested_gl_account_id
        WHERE bt.company_id = ${companyId}::uuid
          AND bt.status IN ('matched', 'reconciled')
          AND bt.matched_journal_line_id IS NOT NULL
          AND bt.suggested_gl_account_id IS NOT NULL
          AND UPPER(bt.description) ILIKE ${likePattern}
        GROUP BY bt.suggested_gl_account_id, bt.suggested_category,
                 bt.suggested_vat_code, ga.account_code, ga.account_name
        ORDER BY match_count DESC
        LIMIT 1
      `) as Row[];

      if (!rows[0]) return;

      const row = rows[0]!;
      const matchCount = Number(row.match_count);
      const baseConfidence = matchCount >= 5 ? 0.70 : matchCount >= 2 ? 0.55 : 0.40;

      const histResult: CategorizationResult = {
        glAccountId:   row.suggested_gl_account_id ? String(row.suggested_gl_account_id) : undefined,
        glAccountCode: row.gl_account_code         ? String(row.gl_account_code)          : undefined,
        glAccountName: row.gl_account_name         ? String(row.gl_account_name)          : undefined,
        category:      row.suggested_category      ? String(row.suggested_category)       : undefined,
        vatCode:       String(row.suggested_vat_code || 'none'),
        confidence: baseConfidence,
        confidenceLevel: toConfidenceLevel(baseConfidence),
        matchSource: 'historical',
        matchDetail: `Historical: ${matchCount} similar transaction(s)`,
      };

      // Apply to all transactions in this group
      for (const tx of txGroup) {
        result.set(tx.txId, histResult);
      }
    } catch (err) {
      log.error('Historical bulk match failed', { key, error: err }, 'accounting');
    }
  }));

  return result;
}

// ── Pattern learning ─────────────────────────────────────────────────────────

export function extractLearningPattern(description: string): string {
  let clean = description.toUpperCase();
  clean = clean.replace(/\b\d{4}\*+\d{4}\b/g, '');
  clean = clean.replace(/\b\d{2}\/\d{2}\/\d{2,4}\b/g, '');
  clean = clean.replace(/\b\d{6,}\b/g, '');
  clean = clean.replace(/\bREF\s*:?\s*\S+/gi, '');
  clean = clean.replace(/\bPOS\b/g, '');
  clean = clean.replace(/\bPURCHASE\b/g, '');
  clean = clean.replace(/\s+/g, ' ').trim();
  const parts = clean.split(/\s{2,}/);
  return parts[0]?.trim() || clean;
}

export async function learnFromAllocation(companyId: string,
  txId: string,
  glAccountId: string,
  category: string,
  vatCode?: string
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
