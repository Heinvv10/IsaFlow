// RED phase — written before implementation
/**
 * Unit tests for fuzzyMatcher.ts
 * Tests fuzzy string matching used for customer/supplier name resolution during migration.
 */

import { describe, it, expect } from 'vitest';
import { fuzzyMatch, fuzzyRank } from '@/modules/accounting/utils/fuzzyMatcher';

// ── Exact matches ─────────────────────────────────────────────────────────────

describe('fuzzyMatch — exact matches', () => {
  it('returns score 1.0 for identical strings', () => {
    const result = fuzzyMatch('Acme Corp', ['Acme Corp', 'Beta Ltd']);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(1.0);
    expect(result!.match).toBe('Acme Corp');
  });

  it('matches case-insensitively (normalized)', () => {
    const result = fuzzyMatch('acme corp', ['Acme Corp']);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(1.0);
  });

  it('strips legal suffixes before matching — Pty Ltd vs Pty Ltd omitted', () => {
    const result = fuzzyMatch('Acme (Pty) Ltd', ['Acme']);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(1.0);
    expect(result!.match).toBe('Acme');
  });

  it('strips "Limited" suffix', () => {
    const result = fuzzyMatch('Beta Limited', ['Beta']);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(1.0);
  });

  it('strips "Inc" suffix', () => {
    const result = fuzzyMatch('Gamma Inc', ['Gamma']);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(1.0);
  });

  it('strips "CC" suffix', () => {
    const result = fuzzyMatch('Delta CC', ['Delta']);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(1.0);
  });
});

// ── Threshold behavior ────────────────────────────────────────────────────────

describe('fuzzyMatch — threshold', () => {
  it('returns null when best score is below default threshold (0.7)', () => {
    const result = fuzzyMatch('Completely Different', ['Acme Corp']);
    expect(result).toBeNull();
  });

  it('finds near-match above threshold', () => {
    const result = fuzzyMatch('Acme Corp', ['Acme Corporation'], 0.6);
    expect(result).not.toBeNull();
    expect(result!.match).toBe('Acme Corporation');
  });

  it('returns null when threshold set to 1.0 and match is not exact', () => {
    const result = fuzzyMatch('Acme Corp', ['Acme Corporation'], 1.0);
    expect(result).toBeNull();
  });

  it('respects lower threshold of 0.5 — finds weaker matches', () => {
    const result = fuzzyMatch('Widget Fact', ['Widget Factory'], 0.5);
    expect(result).not.toBeNull();
  });

  it('custom threshold 0.8 — rejects borderline match', () => {
    // Very different strings should not match at 0.8
    const result = fuzzyMatch('Alpha', ['Omega'], 0.8);
    expect(result).toBeNull();
  });
});

// ── Best match selection ──────────────────────────────────────────────────────

describe('fuzzyMatch — best match selection', () => {
  it('returns the highest-scoring match when multiple candidates exist', () => {
    const haystack = ['Acme Corp', 'Acme Corporation', 'Acme Supplies'];
    const result = fuzzyMatch('Acme Corp', haystack);
    expect(result).not.toBeNull();
    expect(result!.match).toBe('Acme Corp');
    expect(result!.score).toBe(1.0);
  });

  it('picks better of two near-matches', () => {
    const haystack = ['Widget Facto', 'Widget Factory'];
    const result = fuzzyMatch('Widget Factory', haystack);
    expect(result).not.toBeNull();
    expect(result!.match).toBe('Widget Factory');
    expect(result!.score).toBe(1.0);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('fuzzyMatch — edge cases', () => {
  it('returns null for empty needle', () => {
    const result = fuzzyMatch('', ['Acme Corp']);
    expect(result).toBeNull();
  });

  it('returns null for empty haystack', () => {
    const result = fuzzyMatch('Acme Corp', []);
    expect(result).toBeNull();
  });

  it('returns null when needle normalizes to empty string', () => {
    // String that strips to nothing (only special chars/legal suffixes)
    const result = fuzzyMatch('(Pty) Ltd', ['Something']);
    expect(result).toBeNull();
  });

  it('handles single-character strings', () => {
    const result = fuzzyMatch('A', ['A', 'B', 'C']);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(1.0);
    expect(result!.match).toBe('A');
  });

  it('handles strings with punctuation', () => {
    const result = fuzzyMatch('O\'Brien & Sons', ['OBrien Sons'], 0.5);
    expect(result).not.toBeNull();
  });
});

// ── fuzzyRank ─────────────────────────────────────────────────────────────────

describe('fuzzyRank', () => {
  it('returns sorted results from best to worst', () => {
    const haystack = ['Acme Corp', 'Acme Corporation', 'Totally Different'];
    const results = fuzzyRank('Acme Corp', haystack, 0.5);
    expect(results.length).toBeGreaterThan(0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  it('excludes results below threshold', () => {
    const haystack = ['Acme Corp', 'Completely Different String'];
    const results = fuzzyRank('Acme Corp', haystack, 0.9);
    expect(results.every(r => r.score >= 0.9)).toBe(true);
  });

  it('returns empty array for empty haystack', () => {
    const results = fuzzyRank('Acme Corp', []);
    expect(results).toEqual([]);
  });

  it('returns empty array for empty needle', () => {
    const results = fuzzyRank('', ['Acme Corp']);
    expect(results).toEqual([]);
  });

  it('returns all matches above threshold 0.5', () => {
    const haystack = ['Acme Corp', 'Acme Corporation', 'Acme Supplies Co'];
    const results = fuzzyRank('Acme Corp', haystack, 0.5);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('scores are in [0, 1] range', () => {
    const results = fuzzyRank('Test Company', ['Test Corp', 'Test Company Ltd', 'Testing Co'], 0.3);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('includes the original candidate string in match field', () => {
    const haystack = ['Widget Factory (Pty) Ltd'];
    const results = fuzzyRank('Widget Factory', haystack, 0.5);
    if (results.length > 0) {
      expect(results[0]!.match).toBe('Widget Factory (Pty) Ltd');
    }
  });
});

// ── Accuracy at various thresholds (migration-relevant scenarios) ─────────────

describe('fuzzyMatch — migration accuracy scenarios', () => {
  const customers = [
    'Acme Enterprises',
    'Beta Supplies',
    'Gamma Trading',
    'Delta Construction',
    'Epsilon Manufacturing',
  ];

  it('matches typo: "Acme Enterpriises" → "Acme Enterprises"', () => {
    const result = fuzzyMatch('Acme Enterpriises', customers, 0.7);
    expect(result).not.toBeNull();
    expect(result!.match).toBe('Acme Enterprises');
  });

  it('matches truncated: "Beta Sup" → "Beta Supplies" at lower threshold', () => {
    const result = fuzzyMatch('Beta Sup', customers, 0.5);
    expect(result).not.toBeNull();
    expect(result!.match).toBe('Beta Supplies');
  });

  it('does not match completely unrelated names at default threshold', () => {
    const result = fuzzyMatch('XYZ Holdings', customers, 0.7);
    expect(result).toBeNull();
  });

  it('handles t/a trading name stripping', () => {
    // "Gamma Trading T/A Something" → normalized to "gamma trading something" → should match
    const result = fuzzyMatch('Gamma Trading T/A Something', customers, 0.5);
    // T/A is stripped, 'gamma trading' portion should score reasonably
    expect(result).not.toBeNull();
  });

  it('scores rounded to 3 decimal places', () => {
    const result = fuzzyMatch('Acme Enterprises', customers);
    expect(result).not.toBeNull();
    const decimalPart = result!.score.toString().split('.')[1] ?? '';
    expect(decimalPart.length).toBeLessThanOrEqual(3);
  });
});
