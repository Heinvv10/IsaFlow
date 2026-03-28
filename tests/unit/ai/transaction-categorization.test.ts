/**
 * TDD: AI Transaction Categorization Tests
 * RED phase — tests the categorization engine logic (not actual LLM calls).
 */

import { describe, it, expect } from 'vitest';
import {
  buildCategorizationPrompt,
  parseCategorizationResponse,
  selectCategorizationStrategy,
  calculateConfidence,
  mergeCategorizationResults,
  type TransactionContext,
  type CategorizationResult,
  type ChartOfAccountEntry,
  type CategorizationStrategy,
} from '@/modules/accounting/services/aiCategorizationService';

// ═══════════════════════════════════════════════════════════════════════════
// PROMPT BUILDING
// ═══════════════════════════════════════════════════════════════════════════

describe('Categorization Prompt Building', () => {
  const sampleAccounts: ChartOfAccountEntry[] = [
    { code: '5000', name: 'Cost of Sales', type: 'expense' },
    { code: '5100', name: 'Advertising', type: 'expense' },
    { code: '5200', name: 'Bank Charges', type: 'expense' },
    { code: '5300', name: 'Telephone', type: 'expense' },
    { code: '5400', name: 'Rent', type: 'expense' },
    { code: '4000', name: 'Sales Revenue', type: 'revenue' },
  ];

  const sampleTx: TransactionContext = {
    description: 'WOOLWORTHS SANDTON 4521',
    amount: -1250.00,
    date: '2026-03-15',
    isDebit: true,
  };

  it('builds prompt with transaction details', () => {
    const prompt = buildCategorizationPrompt(sampleTx, sampleAccounts);
    expect(prompt).toContain('WOOLWORTHS');
    expect(prompt).toContain('1250');
  });

  it('includes chart of accounts in prompt', () => {
    const prompt = buildCategorizationPrompt(sampleTx, sampleAccounts);
    expect(prompt).toContain('5000');
    expect(prompt).toContain('Cost of Sales');
    expect(prompt).toContain('5100');
  });

  it('indicates debit/credit direction', () => {
    const prompt = buildCategorizationPrompt(sampleTx, sampleAccounts);
    expect(prompt.toLowerCase()).toContain('debit');
  });

  it('includes date context', () => {
    const prompt = buildCategorizationPrompt(sampleTx, sampleAccounts);
    expect(prompt).toContain('2026');
  });

  it('requests JSON response format', () => {
    const prompt = buildCategorizationPrompt(sampleTx, sampleAccounts);
    expect(prompt.toLowerCase()).toContain('json');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RESPONSE PARSING
// ═══════════════════════════════════════════════════════════════════════════

describe('Categorization Response Parsing', () => {
  it('parses valid JSON response', () => {
    const response = '{"accountCode": "5100", "accountName": "Advertising", "confidence": 0.92, "reason": "Woolworths is retail spending"}';
    const result = parseCategorizationResponse(response);
    expect(result).toBeDefined();
    expect(result!.accountCode).toBe('5100');
    expect(result!.confidence).toBe(0.92);
    expect(result!.reason).toContain('Woolworths');
  });

  it('handles JSON embedded in text', () => {
    const response = 'Based on the transaction:\n```json\n{"accountCode": "5200", "accountName": "Bank Charges", "confidence": 0.85, "reason": "Bank fee"}\n```';
    const result = parseCategorizationResponse(response);
    expect(result).toBeDefined();
    expect(result!.accountCode).toBe('5200');
  });

  it('returns null for invalid response', () => {
    expect(parseCategorizationResponse('I cannot categorize this')).toBeNull();
    expect(parseCategorizationResponse('')).toBeNull();
  });

  it('handles missing fields gracefully', () => {
    const response = '{"accountCode": "5000"}';
    const result = parseCategorizationResponse(response);
    expect(result).toBeDefined();
    expect(result!.accountCode).toBe('5000');
    expect(result!.confidence).toBeDefined(); // should default
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY SELECTION (Rules → Patterns → LLM)
// ═══════════════════════════════════════════════════════════════════════════

describe('Categorization Strategy Selection', () => {
  it('selects rules strategy when rule match exists', () => {
    const strategy = selectCategorizationStrategy({
      hasRuleMatch: true,
      hasPatternMatch: false,
      ruleConfidence: 1.0,
      patternConfidence: 0,
    });
    expect(strategy).toBe('rules');
  });

  it('selects patterns strategy when pattern match with high confidence', () => {
    const strategy = selectCategorizationStrategy({
      hasRuleMatch: false,
      hasPatternMatch: true,
      ruleConfidence: 0,
      patternConfidence: 0.9,
    });
    expect(strategy).toBe('patterns');
  });

  it('selects LLM when no rule or pattern match', () => {
    const strategy = selectCategorizationStrategy({
      hasRuleMatch: false,
      hasPatternMatch: false,
      ruleConfidence: 0,
      patternConfidence: 0,
    });
    expect(strategy).toBe('llm');
  });

  it('selects LLM when pattern confidence is low', () => {
    const strategy = selectCategorizationStrategy({
      hasRuleMatch: false,
      hasPatternMatch: true,
      ruleConfidence: 0,
      patternConfidence: 0.4,
    });
    expect(strategy).toBe('llm');
  });

  it('prefers rules over patterns when both match', () => {
    const strategy = selectCategorizationStrategy({
      hasRuleMatch: true,
      hasPatternMatch: true,
      ruleConfidence: 1.0,
      patternConfidence: 0.8,
    });
    expect(strategy).toBe('rules');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONFIDENCE CALCULATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Confidence Calculation', () => {
  it('returns HIGH for confidence >= 0.85', () => {
    expect(calculateConfidence(0.95).level).toBe('HIGH');
    expect(calculateConfidence(0.85).level).toBe('HIGH');
  });

  it('returns MEDIUM for confidence 0.60-0.84', () => {
    expect(calculateConfidence(0.75).level).toBe('MEDIUM');
    expect(calculateConfidence(0.60).level).toBe('MEDIUM');
  });

  it('returns LOW for confidence < 0.60', () => {
    expect(calculateConfidence(0.50).level).toBe('LOW');
    expect(calculateConfidence(0.1).level).toBe('LOW');
  });

  it('returns color coding', () => {
    expect(calculateConfidence(0.9).color).toBe('green');
    expect(calculateConfidence(0.7).color).toBe('amber');
    expect(calculateConfidence(0.3).color).toBe('gray');
  });

  it('clamps confidence to 0-1 range', () => {
    expect(calculateConfidence(1.5).level).toBe('HIGH');
    expect(calculateConfidence(-0.5).level).toBe('LOW');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RESULT MERGING (combine rule + pattern + LLM results)
// ═══════════════════════════════════════════════════════════════════════════

describe('Result Merging', () => {
  it('uses highest confidence result and boosts when agreeing', () => {
    const results: CategorizationResult[] = [
      { accountCode: '5100', accountName: 'Advertising', confidence: 0.6, reason: 'Pattern match', strategy: 'patterns' },
      { accountCode: '5100', accountName: 'Advertising', confidence: 0.92, reason: 'LLM categorized', strategy: 'llm' },
    ];
    const merged = mergeCategorizationResults(results);
    // Both agree on 5100 → boosted above 0.92
    expect(merged.confidence).toBeGreaterThanOrEqual(0.92);
    expect(merged.accountCode).toBe('5100');
  });

  it('boosts confidence when multiple strategies agree', () => {
    const results: CategorizationResult[] = [
      { accountCode: '5200', accountName: 'Bank Charges', confidence: 0.7, reason: 'Pattern', strategy: 'patterns' },
      { accountCode: '5200', accountName: 'Bank Charges', confidence: 0.8, reason: 'LLM', strategy: 'llm' },
    ];
    const merged = mergeCategorizationResults(results);
    // Both agree → confidence should be boosted above individual max
    expect(merged.confidence).toBeGreaterThan(0.8);
  });

  it('uses rule result when available (highest priority)', () => {
    const results: CategorizationResult[] = [
      { accountCode: '5200', accountName: 'Bank Charges', confidence: 1.0, reason: 'Rule match', strategy: 'rules' },
      { accountCode: '5300', accountName: 'Telephone', confidence: 0.9, reason: 'LLM', strategy: 'llm' },
    ];
    const merged = mergeCategorizationResults(results);
    expect(merged.accountCode).toBe('5200');
    expect(merged.strategy).toBe('rules');
  });

  it('handles empty results', () => {
    const merged = mergeCategorizationResults([]);
    expect(merged.accountCode).toBe('');
    expect(merged.confidence).toBe(0);
  });

  it('handles single result', () => {
    const results: CategorizationResult[] = [
      { accountCode: '5100', accountName: 'Advertising', confidence: 0.8, reason: 'LLM', strategy: 'llm' },
    ];
    const merged = mergeCategorizationResults(results);
    expect(merged.accountCode).toBe('5100');
    expect(merged.confidence).toBe(0.8);
  });
});
