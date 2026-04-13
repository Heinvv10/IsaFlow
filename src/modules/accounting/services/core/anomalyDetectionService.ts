/**
 * Anomaly Detection & Smart Alerts Service
 * Benford's Law, statistical outliers, duplicate payments, posting patterns, risk scoring.
 * Pure business logic — no database dependencies.
 */

export interface Transaction {
  id: string;
  amount: number;
  description: string;
  date: string;
}

export interface BenfordsResult {
  conforming: boolean;
  chiSquare: number;
  distribution: Record<string, number>;
  sampleSize: number;
}

export interface OutlierResult {
  outliers: Array<Transaction & { zScore: number }>;
  mean: number;
  stdDev: number;
}

export interface DuplicateCandidate {
  payment1Id: string;
  payment2Id: string;
  amount: number;
  supplierId: string;
  confidence: number;
  reason: string;
}

export interface PostingAnomaly {
  type: 'weekend_posting' | 'round_numbers' | 'after_hours' | 'burst_posting';
  entryIds: string[];
  description: string;
}

export interface RiskScore {
  score: number; // 0-100
  level: 'low' | 'medium' | 'high';
  factors: string[];
}

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface AlertMessage {
  severity: AlertSeverity;
  title: string;
  description: string;
  timestamp: string;
  type: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// BENFORD'S LAW
// ═══════════════════════════════════════════════════════════════════════════

const BENFORD_EXPECTED: Record<number, number> = {
  1: 0.301, 2: 0.176, 3: 0.125, 4: 0.097, 5: 0.079,
  6: 0.067, 7: 0.058, 8: 0.051, 9: 0.046,
};

export function benfordsLawAnalysis(amounts: number[]): BenfordsResult {
  const filtered = amounts.filter(a => a > 0);
  const distribution: Record<string, number> = {};
  for (let d = 1; d <= 9; d++) distribution[String(d)] = 0;

  if (filtered.length === 0) {
    return { conforming: true, chiSquare: 0, distribution, sampleSize: 0 };
  }

  for (const amt of filtered) {
    const firstDigit = String(Math.abs(amt))[0]!;
    if (firstDigit >= '1' && firstDigit <= '9') {
      distribution[firstDigit] = (distribution[firstDigit] || 0) + 1;
    }
  }

  // Normalize to proportions
  const n = filtered.length;
  let chiSquare = 0;
  for (let d = 1; d <= 9; d++) {
    const observed = (distribution[String(d)] || 0) / n;
    const expected = BENFORD_EXPECTED[d]!;
    chiSquare += Math.pow(observed - expected, 2) / expected;
  }
  chiSquare = Math.round(chiSquare * n * 100) / 100;

  // Chi-square critical value for 8 df at 95% = 15.507
  const conforming = chiSquare < 15.507 || n < 10;

  return { conforming, chiSquare, distribution, sampleSize: n };
}

// ═══════════════════════════════════════════════════════════════════════════
// STATISTICAL OUTLIERS (Z-SCORE)
// ═══════════════════════════════════════════════════════════════════════════

export function detectStatisticalOutliers(transactions: Transaction[], threshold = 2.5): OutlierResult {
  if (transactions.length < 3) return { outliers: [], mean: 0, stdDev: 0 };

  const amounts = transactions.map(t => Math.abs(t.amount));
  const mean = amounts.reduce((s, a) => s + a, 0) / amounts.length;
  const variance = amounts.reduce((s, a) => s + Math.pow(a - mean, 2), 0) / amounts.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return { outliers: [], mean, stdDev: 0 };

  const outliers = transactions
    .map(t => ({ ...t, zScore: Math.round(Math.abs((Math.abs(t.amount) - mean) / stdDev) * 100) / 100 }))
    .filter(t => t.zScore > threshold)
    .sort((a, b) => b.zScore - a.zScore);

  return { outliers, mean: Math.round(mean * 100) / 100, stdDev: Math.round(stdDev * 100) / 100 };
}

// ═══════════════════════════════════════════════════════════════════════════
// DUPLICATE PAYMENT DETECTION
// ═══════════════════════════════════════════════════════════════════════════

export function detectDuplicatePayments(
  payments: Array<{ id: string; supplierId: string; amount: number; date: string; reference: string }>,
): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = [];

  for (let i = 0; i < payments.length; i++) {
    for (let j = i + 1; j < payments.length; j++) {
      const a = payments[i]!;
      const b = payments[j]!;

      if (a.supplierId !== b.supplierId) continue;
      if (a.amount !== b.amount) continue;

      const daysDiff = Math.abs(new Date(a.date).getTime() - new Date(b.date).getTime()) / (1000 * 60 * 60 * 24);
      if (daysDiff > 7) continue; // More than 7 days apart = likely not duplicate

      let confidence = 0.7;
      if (daysDiff === 0) confidence = 0.95;
      else if (daysDiff <= 1) confidence = 0.9;
      else if (daysDiff <= 3) confidence = 0.8;

      if (a.reference === b.reference && a.reference) confidence = Math.min(1, confidence + 0.05);

      candidates.push({
        payment1Id: a.id, payment2Id: b.id,
        amount: a.amount, supplierId: a.supplierId,
        confidence: Math.round(confidence * 100) / 100,
        reason: `Same supplier, same amount (R${a.amount}), ${daysDiff} days apart`,
      });
    }
  }

  return candidates;
}

// ═══════════════════════════════════════════════════════════════════════════
// UNUSUAL POSTING PATTERNS
// ═══════════════════════════════════════════════════════════════════════════

export function detectUnusualPostingPatterns(
  entries: Array<{ id: string; date: string; amount: number; userId: string; description: string }>,
): PostingAnomaly[] {
  const anomalies: PostingAnomaly[] = [];

  // Weekend postings
  const weekendEntries = entries.filter(e => {
    const day = new Date(e.date).getDay();
    return day === 0 || day === 6;
  });
  if (weekendEntries.length > 0) {
    anomalies.push({
      type: 'weekend_posting',
      entryIds: weekendEntries.map(e => e.id),
      description: `${weekendEntries.length} journal entries posted on weekends`,
    });
  }

  // Round number patterns (all amounts divisible by 1000)
  const roundEntries = entries.filter(e => e.amount > 0 && e.amount % 1000 === 0);
  if (roundEntries.length > entries.length * 0.7 && entries.length >= 5) {
    anomalies.push({
      type: 'round_numbers',
      entryIds: roundEntries.map(e => e.id),
      description: `${roundEntries.length} of ${entries.length} entries are round numbers (possible estimation)`,
    });
  }

  return anomalies;
}

// ═══════════════════════════════════════════════════════════════════════════
// JOURNAL ENTRY RISK SCORING
// ═══════════════════════════════════════════════════════════════════════════

export function scoreJournalEntryRisk(input: {
  amount: number;
  isManual: boolean;
  isWeekend: boolean;
  isRoundNumber: boolean;
  isNearPeriodEnd: boolean;
  hasDescription: boolean;
  lineCount: number;
}): RiskScore {
  let score = 0;
  const factors: string[] = [];

  if (input.isManual) { score += 15; factors.push('Manual journal entry'); }
  if (input.isWeekend) { score += 20; factors.push('Posted on weekend'); }
  if (input.isRoundNumber) { score += 10; factors.push('Round number amount'); }
  if (input.isNearPeriodEnd) { score += 10; factors.push('Near period-end'); }
  if (!input.hasDescription) { score += 15; factors.push('Missing description'); }
  if (input.amount > 50000) { score += 10; factors.push('Large amount'); }
  if (input.amount > 100000) { score += 10; }
  if (input.lineCount > 10) { score += 5; factors.push('Many line items'); }

  score = Math.min(100, score);
  const level: RiskScore['level'] = score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';

  return { score, level, factors };
}

// ═══════════════════════════════════════════════════════════════════════════
// ALERT MESSAGES
// ═══════════════════════════════════════════════════════════════════════════

const ALERT_TEMPLATES: Record<string, { title: string; template: string }> = {
  duplicate_payment: { title: 'Possible Duplicate Payment', template: 'Duplicate payment of R{amount} detected to {supplier}' },
  unusual_amount: { title: 'Unusual Transaction Amount', template: 'Transaction of R{amount} is significantly outside normal range' },
  round_number: { title: 'Round Number Pattern', template: 'Entry of R{amount} — round numbers may indicate estimates' },
  weekend_posting: { title: 'Weekend Posting', template: 'Journal entry posted on a weekend' },
  benfords_violation: { title: "Benford's Law Violation", template: 'Transaction amounts do not follow expected distribution' },
};

export function buildAlertMessage(type: string, severity: AlertSeverity, context: Record<string, unknown>): AlertMessage {
  const template = ALERT_TEMPLATES[type] || { title: 'Alert', template: 'An anomaly was detected' };

  let description = template.template;
  for (const [key, value] of Object.entries(context)) {
    description = description.replace(`{${key}}`, String(value));
  }

  return {
    severity,
    title: template.title,
    description,
    timestamp: new Date().toISOString(),
    type,
  };
}
