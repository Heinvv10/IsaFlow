/**
 * Fuzzy Match Utility
 * Matches extracted vendor/customer names against existing database records
 * using Dice coefficient on bigrams for SA business name matching.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface MatchCandidate {
  id: string | number;
  name: string;
}

interface MatchResult {
  id: string | number;
  name: string;
  score: number;
}

const DEFAULT_THRESHOLD = 0.6;

/**
 * Find the best matching supplier from a list.
 */
export function fuzzyMatchSupplier(
  extractedName: string,
  suppliers: Array<{ id: string | number; name: string }>,
  threshold = DEFAULT_THRESHOLD,
): MatchResult | null {
  return findBestMatch(extractedName, suppliers, threshold);
}

/**
 * Find the best matching client from a list.
 * Handles `companyName` field mapping.
 */
export function fuzzyMatchClient(
  extractedName: string,
  clients: Array<{ id: string | number; companyName?: string; name?: string; company_name?: string }>,
  threshold = DEFAULT_THRESHOLD,
): MatchResult | null {
  const candidates: MatchCandidate[] = clients.map(c => ({
    id: c.id,
    name: c.companyName || c.company_name || c.name || '',
  }));
  return findBestMatch(extractedName, candidates, threshold);
}

// ---------------------------------------------------------------------------
// Core matching
// ---------------------------------------------------------------------------

function findBestMatch(
  query: string,
  candidates: MatchCandidate[],
  threshold: number,
): MatchResult | null {
  if (!query || candidates.length === 0) return null;

  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return null;

  let best: MatchResult | null = null;

  for (const candidate of candidates) {
    const normalizedCandidate = normalize(candidate.name);
    if (!normalizedCandidate) continue;

    // Exact match after normalization
    if (normalizedQuery === normalizedCandidate) {
      return { id: candidate.id, name: candidate.name, score: 1.0 };
    }

    // Containment check (one contains the other)
    if (normalizedQuery.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedQuery)) {
      const score = Math.min(normalizedQuery.length, normalizedCandidate.length) /
        Math.max(normalizedQuery.length, normalizedCandidate.length);
      const adjustedScore = 0.7 + score * 0.3; // Range: 0.7 - 1.0
      if (adjustedScore >= threshold && (!best || adjustedScore > best.score)) {
        best = { id: candidate.id, name: candidate.name, score: Math.round(adjustedScore * 100) / 100 };
      }
      continue;
    }

    // Dice coefficient on bigrams
    const score = diceCoefficient(normalizedQuery, normalizedCandidate);
    if (score >= threshold && (!best || score > best.score)) {
      best = { id: candidate.id, name: candidate.name, score: Math.round(score * 100) / 100 };
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Normalization — strips SA business suffixes and noise
// ---------------------------------------------------------------------------

const STRIP_PATTERNS = [
  /\b\(pty\)\b/gi,
  /\bpty\b/gi,
  /\bltd\b/gi,
  /\blimited\b/gi,
  /\binc\b/gi,
  /\bincorporated\b/gi,
  /\bcc\b/gi,
  /\bnpc\b/gi,
  /\bsoc\b/gi,
  /\bt\/a\b/gi,
  /\btrading\s+as\b/gi,
];

function normalize(name: string): string {
  let s = name.toLowerCase().trim();
  for (const pattern of STRIP_PATTERNS) {
    s = s.replace(pattern, '');
  }
  // Remove punctuation and collapse whitespace
  s = s.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  return s;
}

// ---------------------------------------------------------------------------
// Dice coefficient on bigrams
// ---------------------------------------------------------------------------

function bigrams(str: string): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i < str.length - 1; i++) {
    result.add(str.substring(i, i + 2));
  }
  return result;
}

function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);

  let intersectionSize = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersectionSize++;
  }

  return (2 * intersectionSize) / (bigramsA.size + bigramsB.size);
}
