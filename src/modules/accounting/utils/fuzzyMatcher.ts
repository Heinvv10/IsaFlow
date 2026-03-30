/**
 * Fuzzy Matcher Utility
 * PRD: Customer Migration Wizard — Phase 1
 *
 * Generic fuzzy matching for migration contact name resolution.
 * Complements fuzzyMatch.ts (which is supplier/client specific) with a
 * simpler needle-in-haystack API used by migration services.
 *
 * Uses Levenshtein edit distance normalized to [0, 1] similarity score,
 * with a Dice bigram coefficient fallback for longer strings (>6 chars).
 */

export interface FuzzyMatchResult {
  match: string;
  score: number;  // 0.0 – 1.0, higher is better
}

const DEFAULT_THRESHOLD = 0.7;

/**
 * Find the best fuzzy match for needle in a haystack of strings.
 *
 * @param needle    String to search for
 * @param haystack  Candidate strings
 * @param threshold Minimum score to accept (default 0.7)
 * @returns Best match with score, or null if nothing meets the threshold
 */
export function fuzzyMatch(
  needle: string,
  haystack: string[],
  threshold = DEFAULT_THRESHOLD,
): FuzzyMatchResult | null {
  if (!needle || haystack.length === 0) return null;

  const normalizedNeedle = normalize(needle);
  if (!normalizedNeedle) return null;

  let best: FuzzyMatchResult | null = null;

  for (const candidate of haystack) {
    const normalizedCandidate = normalize(candidate);
    if (!normalizedCandidate) continue;

    // Exact match shortcut
    if (normalizedNeedle === normalizedCandidate) {
      return { match: candidate, score: 1.0 };
    }

    const score = scoreStrings(normalizedNeedle, normalizedCandidate);
    if (score >= threshold && (!best || score > best.score)) {
      best = { match: candidate, score: Math.round(score * 1000) / 1000 };
    }
  }

  return best;
}

/**
 * Score all haystack items against needle, returning sorted results.
 * Useful for showing ranked match suggestions in the UI.
 */
export function fuzzyRank(
  needle: string,
  haystack: string[],
  threshold = 0.5,
): FuzzyMatchResult[] {
  if (!needle || haystack.length === 0) return [];

  const normalizedNeedle = normalize(needle);
  if (!normalizedNeedle) return [];

  const results: FuzzyMatchResult[] = [];

  for (const candidate of haystack) {
    const normalizedCandidate = normalize(candidate);
    if (!normalizedCandidate) continue;
    const score = normalizedNeedle === normalizedCandidate ? 1.0 : scoreStrings(normalizedNeedle, normalizedCandidate);
    if (score >= threshold) {
      results.push({ match: candidate, score: Math.round(score * 1000) / 1000 });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

// ── Scoring ──────────────────────────────────────────────────────────────────

function scoreStrings(a: string, b: string): number {
  // For short strings (<= 6 chars), Levenshtein is more accurate
  if (a.length <= 6 || b.length <= 6) {
    return levenshteinSimilarity(a, b);
  }
  // For longer strings, average Dice + Levenshtein
  const dice = diceCoefficient(a, b);
  const lev  = levenshteinSimilarity(a, b);
  return (dice + lev) / 2;
}

function levenshteinSimilarity(a: string, b: string): number {
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1 - dist / maxLen;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (__, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigramsA = new Set<string>();
  const bigramsB = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.substring(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.substring(i, i + 2));
  let intersection = 0;
  for (const bg of bigramsA) { if (bigramsB.has(bg)) intersection++; }
  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

// ── Normalization ─────────────────────────────────────────────────────────────

const STRIP_PATTERNS = [
  /\b\(pty\)\b/gi,
  /\bpty\b/gi,
  /\bltd\b/gi,
  /\blimited\b/gi,
  /\binc\b/gi,
  /\bcc\b/gi,
  /\bnpc\b/gi,
  /\bt\/a\b/gi,
];

function normalize(name: string): string {
  let s = name.toLowerCase().trim();
  for (const pattern of STRIP_PATTERNS) {
    s = s.replace(pattern, '');
  }
  return s.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
