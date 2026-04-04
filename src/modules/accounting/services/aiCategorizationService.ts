/**
 * AI Transaction Categorization Service
 * Tiered approach: Rules (free) → Patterns → LLM (Claude API)
 * Pure business logic for prompt building, parsing, strategy selection.
 * Actual LLM calls are made by the API layer.
 */

export interface TransactionContext {
  description: string;
  amount: number;
  date: string;
  isDebit: boolean;
  bankName?: string;
  reference?: string;
}

export interface ChartOfAccountEntry {
  code: string;
  name: string;
  type: string;
}

export interface CategorizationResult {
  accountCode: string;
  accountName: string;
  confidence: number;
  reason: string;
  strategy: CategorizationStrategy;
  vatCode?: string;
  vatReason?: string;
}

export type CategorizationStrategy = 'rules' | 'patterns' | 'llm';

export interface ConfidenceLevel {
  level: 'HIGH' | 'MEDIUM' | 'LOW';
  color: 'green' | 'amber' | 'gray';
  score: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROMPT BUILDING
// ═══════════════════════════════════════════════════════════════════════════

export function buildCategorizationPrompt(
  tx: TransactionContext,
  accounts: ChartOfAccountEntry[],
): string {
  const direction = tx.isDebit ? 'debit (money out)' : 'credit (money in)';
  const accountList = accounts
    .map(a => `  ${a.code} - ${a.name} (${a.type})`)
    .join('\n');

  return `You are a South African bookkeeper. Categorize this bank transaction to the correct GL account.

Transaction:
- Description: ${tx.description}
- Amount: R${Math.abs(tx.amount).toFixed(2)}
- Direction: ${direction}
- Date: ${tx.date}
${tx.reference ? `- Reference: ${tx.reference}` : ''}

Chart of Accounts:
${accountList}

Respond in JSON format only:
{"accountCode": "xxxx", "accountName": "Account Name", "confidence": 0.0-1.0, "reason": "Brief explanation"}

Rules:
- Match the transaction to the most appropriate account
- Consider South African merchant names and conventions
- Confidence should reflect how certain you are (0.5 = guess, 0.9+ = very confident)
- For ${direction}, select an appropriate ${tx.isDebit ? 'expense/asset' : 'revenue/liability'} account`;
}

// ═══════════════════════════════════════════════════════════════════════════
// RESPONSE PARSING
// ═══════════════════════════════════════════════════════════════════════════

export function parseCategorizationResponse(response: string): CategorizationResult | null {
  if (!response || response.trim() === '') return null;

  try {
    // Try to extract JSON from the response (might be wrapped in markdown code blocks)
    let jsonStr = response;

    // Extract from ```json ... ``` blocks
    const jsonMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1]!;
    } else {
      // Try to find a JSON object in the text
      const objMatch = response.match(/\{[\s\S]*"accountCode"[\s\S]*\}/);
      if (objMatch) {
        jsonStr = objMatch[0];
      }
    }

    const parsed = JSON.parse(jsonStr);

    return {
      accountCode: String(parsed.accountCode || ''),
      accountName: String(parsed.accountName || ''),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      reason: String(parsed.reason || ''),
      strategy: 'llm',
    };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY SELECTION
// ═══════════════════════════════════════════════════════════════════════════

const PATTERN_CONFIDENCE_THRESHOLD = 0.6;

export function selectCategorizationStrategy(input: {
  hasRuleMatch: boolean;
  hasPatternMatch: boolean;
  ruleConfidence: number;
  patternConfidence: number;
}): CategorizationStrategy {
  // Rules are always preferred (deterministic, free)
  if (input.hasRuleMatch && input.ruleConfidence > 0) return 'rules';

  // Patterns used if confidence is high enough
  if (input.hasPatternMatch && input.patternConfidence >= PATTERN_CONFIDENCE_THRESHOLD) return 'patterns';

  // Fall back to LLM
  return 'llm';
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIDENCE
// ═══════════════════════════════════════════════════════════════════════════

export function calculateConfidence(score: number): ConfidenceLevel {
  const clamped = Math.max(0, Math.min(1, score));

  if (clamped >= 0.85) return { level: 'HIGH', color: 'green', score: clamped };
  if (clamped >= 0.60) return { level: 'MEDIUM', color: 'amber', score: clamped };
  return { level: 'LOW', color: 'gray', score: clamped };
}

// ═══════════════════════════════════════════════════════════════════════════
// RESULT MERGING
// ═══════════════════════════════════════════════════════════════════════════

export function mergeCategorizationResults(results: CategorizationResult[]): CategorizationResult {
  if (results.length === 0) {
    return { accountCode: '', accountName: '', confidence: 0, reason: '', strategy: 'llm' };
  }

  if (results.length === 1) return results[0]!;

  // Rules always win if present
  const ruleResult = results.find(r => r.strategy === 'rules');
  if (ruleResult) return ruleResult;

  // Check if multiple strategies agree on the same account
  const accountCounts = new Map<string, CategorizationResult[]>();
  for (const r of results) {
    const existing = accountCounts.get(r.accountCode) || [];
    existing.push(r);
    accountCounts.set(r.accountCode, existing);
  }

  // Find the account code with most agreement
  let bestCode = '';
  let bestResults: CategorizationResult[] = [];
  for (const [code, group] of accountCounts) {
    if (group.length > bestResults.length || (group.length === bestResults.length && Math.max(...group.map(r => r.confidence)) > Math.max(...bestResults.map(r => r.confidence)))) {
      bestCode = code;
      bestResults = group;
    }
  }

  const highestConfResult = bestResults.reduce((best, r) => r.confidence > best.confidence ? r : best, bestResults[0]!);

  // Boost confidence when multiple strategies agree
  let boostedConfidence = highestConfResult.confidence;
  if (bestResults.length > 1) {
    boostedConfidence = Math.min(1, boostedConfidence + 0.1 * (bestResults.length - 1));
  }

  return {
    ...highestConfResult,
    confidence: Math.round(boostedConfidence * 100) / 100,
  };
}
