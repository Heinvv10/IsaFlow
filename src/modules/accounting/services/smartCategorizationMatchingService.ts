/**
 * Smart Categorization Matching Service
 * Three-strategy matching: rules, patterns, historical learning.
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

export function toConfidenceLevel(score: number): ConfidenceLevel {
  if (score >= 0.85) return 'HIGH';
  if (score >= 0.60) return 'MEDIUM';
  return 'LOW';
}

// ── Strategy 1: Match against bank_categorisation_rules ──────────────────────

export async function matchAgainstRules(
  description: string,
  reference: string
): Promise<CategorizationResult | null> {
  try {
    const rules = (await sql`
      SELECT r.*, ga.account_code AS gl_account_code, ga.account_name AS gl_account_name
      FROM bank_categorisation_rules r
      LEFT JOIN gl_accounts ga ON ga.id = r.gl_account_id
      WHERE r.is_active = true
      ORDER BY r.priority ASC
    `) as Row[];

    for (const rule of rules) {
      const pattern = String(rule.match_pattern).toUpperCase();
      const matchType = String(rule.match_type);
      const matchField = String(rule.match_field);

      const targets: string[] = [];
      if (matchField === 'description' || matchField === 'both') targets.push(description);
      if (matchField === 'reference' || matchField === 'both') targets.push(reference);

      const matched = targets.some(target => {
        switch (matchType) {
          case 'contains': return target.includes(pattern);
          case 'starts_with': return target.startsWith(pattern);
          case 'ends_with': return target.endsWith(pattern);
          case 'exact': return target === pattern;
          default: return target.includes(pattern);
        }
      });

      if (matched) {
        return {
          glAccountId: rule.gl_account_id ? String(rule.gl_account_id) : undefined,
          glAccountCode: rule.gl_account_code ? String(rule.gl_account_code) : undefined,
          glAccountName: rule.gl_account_name ? String(rule.gl_account_name) : undefined,
          category: String(rule.rule_name),
          vatCode: String(rule.vat_code || 'none'),
          confidence: 0.95,
          confidenceLevel: 'HIGH',
          matchSource: 'rule',
          matchDetail: `Rule: ${rule.rule_name} (${matchType} "${rule.match_pattern}")`,
        };
      }
    }
  } catch (err) {
    log.error('Smart categorization: rule matching failed', { error: err }, 'accounting');
  }
  return null;
}

// ── Strategy 2: Match against categorization_patterns ────────────────────────

export async function matchAgainstPatterns(
  description: string,
  reference: string
): Promise<CategorizationResult | null> {
  try {
    const patterns = (await sql`
      SELECT cp.*, ga.account_code AS gl_account_code, ga.account_name AS gl_account_name
      FROM categorization_patterns cp
      LEFT JOIN gl_accounts ga ON ga.id = cp.gl_account_id
      ORDER BY cp.confidence DESC, cp.usage_count DESC
    `) as Row[];

    const combined = `${description} ${reference}`;

    for (const p of patterns) {
      const pat = String(p.pattern).toUpperCase();
      const matchType = String(p.match_type);

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
            // WORKING: invalid regex patterns are safely skipped
            matched = false;
          }
          break;
        default:
          matched = combined.includes(pat);
      }

      if (matched) {
        const confidence = Number(p.confidence) || 0.80;

        sql`
          UPDATE categorization_patterns
          SET usage_count = usage_count + 1, last_used_at = NOW()
          WHERE id = ${p.id}::UUID
        `.catch(() => {});

        return {
          glAccountId: p.gl_account_id ? String(p.gl_account_id) : undefined,
          glAccountCode: p.gl_account_code ? String(p.gl_account_code) : undefined,
          glAccountName: p.gl_account_name ? String(p.gl_account_name) : undefined,
          category: p.category ? String(p.category) : undefined,
          vatCode: String(p.vat_code || 'standard'),
          confidence,
          confidenceLevel: toConfidenceLevel(confidence),
          matchSource: 'pattern',
          matchDetail: `Pattern: "${p.pattern}" (${p.source})`,
        };
      }
    }
  } catch (err) {
    log.error('Smart categorization: pattern matching failed', { error: err }, 'accounting');
  }
  return null;
}

// ── Strategy 3: Learn from historical allocations ────────────────────────────

export async function matchFromHistory(
  description: string,
  _amount: number
): Promise<CategorizationResult | null> {
  if (!description || description.length < 3) return null;

  try {
    const noiseWords = new Set([
      'THE', 'AND', 'FOR', 'FROM', 'WITH', 'PAYMENT', 'TRANSFER',
      'DEBIT', 'CREDIT', 'ORDER', 'REF', 'POS', 'PURCHASE', 'CARD',
    ]);
    const words = description
      .split(/[\s/\\,.-]+/)
      .filter(w => w.length >= 3 && !noiseWords.has(w) && !/^\d+$/.test(w));

    if (words.length === 0) return null;

    const searchWords = words.slice(0, 3);
    const likePattern = `%${searchWords.join('%')}%`;

    const historicalRows = (await sql`
      SELECT
        bt.suggested_gl_account_id,
        bt.suggested_category,
        bt.suggested_vat_code,
        bt.allocation_type,
        ga.account_code AS gl_account_code,
        ga.account_name AS gl_account_name,
        COUNT(*) AS match_count
      FROM bank_transactions bt
      LEFT JOIN gl_accounts ga ON ga.id = bt.suggested_gl_account_id
      WHERE bt.status IN ('matched', 'reconciled')
        AND bt.matched_journal_line_id IS NOT NULL
        AND bt.suggested_gl_account_id IS NOT NULL
        AND UPPER(bt.description) ILIKE ${likePattern}
      GROUP BY bt.suggested_gl_account_id, bt.suggested_category,
               bt.suggested_vat_code, bt.allocation_type,
               ga.account_code, ga.account_name
      ORDER BY match_count DESC
      LIMIT 1
    `) as Row[];

    const firstHistorical = historicalRows[0];
    if (firstHistorical) {
      const row = firstHistorical;
      const matchCount = Number(row.match_count);
      const baseConfidence = matchCount >= 5 ? 0.70 : matchCount >= 2 ? 0.55 : 0.40;

      return {
        glAccountId: row.suggested_gl_account_id ? String(row.suggested_gl_account_id) : undefined,
        glAccountCode: row.gl_account_code ? String(row.gl_account_code) : undefined,
        glAccountName: row.gl_account_name ? String(row.gl_account_name) : undefined,
        category: row.suggested_category ? String(row.suggested_category) : undefined,
        vatCode: String(row.suggested_vat_code || 'none'),
        confidence: baseConfidence,
        confidenceLevel: toConfidenceLevel(baseConfidence),
        matchSource: 'historical',
        matchDetail: `Historical: ${matchCount} similar transaction(s)`,
      };
    }
  } catch (err) {
    log.error('Smart categorization: historical matching failed', { error: err }, 'accounting');
  }
  return null;
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
      SELECT description FROM bank_transactions WHERE id = ${txId}::UUID
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
      await sql`
        INSERT INTO categorization_patterns (pattern, match_type, gl_account_id, category, vat_code, confidence, usage_count, last_used_at, source)
        VALUES (${pattern}, 'contains', ${glAccountId}::UUID, ${category}, ${vatCode || 'standard'}, 0.65, 1, NOW(), 'learned')
      `;
    }

    log.info('Learned categorization pattern', { pattern, category, glAccountId }, 'accounting');
  } catch (err) {
    log.error('Failed to learn from allocation', { txId, error: err }, 'accounting');
    // Non-critical: don't throw
  }
}
