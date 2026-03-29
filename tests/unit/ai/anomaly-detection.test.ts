/**
 * TDD: Anomaly Detection & Smart Alerts Tests
 * RED phase.
 */

import { describe, it, expect } from 'vitest';
import {
  benfordsLawAnalysis,
  detectStatisticalOutliers,
  detectDuplicatePayments,
  detectUnusualPostingPatterns,
  scoreJournalEntryRisk,
  buildAlertMessage,
  type Transaction,
  type BenfordsResult,
  type OutlierResult,
  type DuplicateCandidate,
  type RiskScore,
  type AlertSeverity,
} from '@/modules/accounting/services/anomalyDetectionService';

// ═══════════════════════════════════════════════════════════════════════════
// BENFORD'S LAW ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

describe("Benford's Law Analysis", () => {
  it('detects conforming distribution', () => {
    // Benford distribution: ~30% start with 1, ~17% with 2, etc.
    const amounts = [
      100, 150, 120, 180, 130, 110, 140, 160, 170, 190, // lots of 1s
      200, 250, 220, 280, 230,  // some 2s
      300, 350, 320, // fewer 3s
      400, 450, 500, 600, 700, 800, 900,
    ];
    const result = benfordsLawAnalysis(amounts);
    expect(result.conforming).toBe(true);
    expect(result.chiSquare).toBeDefined();
  });

  it('detects non-conforming distribution (round numbers)', () => {
    // All amounts starting with 5 — suspicious
    const amounts = Array(100).fill(0).map((_, i) => 5000 + i * 10);
    const result = benfordsLawAnalysis(amounts);
    expect(result.conforming).toBe(false);
  });

  it('returns digit distribution', () => {
    const amounts = [100, 200, 300, 400, 500];
    const result = benfordsLawAnalysis(amounts);
    expect(result.distribution).toBeDefined();
    expect(Object.keys(result.distribution).length).toBe(9); // digits 1-9
  });

  it('handles empty array', () => {
    const result = benfordsLawAnalysis([]);
    expect(result.conforming).toBe(true); // no data = no anomaly
    expect(result.sampleSize).toBe(0);
  });

  it('filters out zero and negative amounts', () => {
    const result = benfordsLawAnalysis([0, -100, 100, 200]);
    expect(result.sampleSize).toBe(2); // only 100, 200 counted
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STATISTICAL OUTLIER DETECTION
// ═══════════════════════════════════════════════════════════════════════════

describe('Statistical Outlier Detection', () => {
  it('detects outliers using z-score', () => {
    const transactions: Transaction[] = [
      ...Array(20).fill(0).map((_, i) => ({ id: String(i), amount: 1000 + (i % 5) * 20, description: 'Normal', date: '2026-03-01' })),
      { id: 'outlier', amount: 50000, description: 'Outlier!', date: '2026-03-05' },
    ];
    const result = detectStatisticalOutliers(transactions);
    expect(result.outliers.length).toBeGreaterThan(0);
    expect(result.outliers[0]!.id).toBe('outlier');
  });

  it('returns no outliers for uniform data', () => {
    const transactions: Transaction[] = Array(20).fill(0).map((_, i) => ({
      id: String(i), amount: 1000 + (i % 5) * 10, description: 'Normal', date: '2026-03-01',
    }));
    const result = detectStatisticalOutliers(transactions);
    expect(result.outliers.length).toBe(0);
  });

  it('returns z-score for each outlier', () => {
    const transactions: Transaction[] = [
      ...Array(10).fill(0).map((_, i) => ({ id: String(i), amount: 100, description: 'N', date: '2026-03-01' })),
      { id: 'outlier', amount: 10000, description: 'Big', date: '2026-03-01' },
    ];
    const result = detectStatisticalOutliers(transactions);
    if (result.outliers.length > 0) {
      expect(result.outliers[0]!.zScore).toBeGreaterThan(2);
    }
  });

  it('handles empty transactions', () => {
    expect(detectStatisticalOutliers([]).outliers.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DUPLICATE PAYMENT DETECTION
// ═══════════════════════════════════════════════════════════════════════════

describe('Duplicate Payment Detection', () => {
  it('detects exact duplicate (same amount + supplier + date)', () => {
    const payments: Array<{ id: string; supplierId: string; amount: number; date: string; reference: string }> = [
      { id: '1', supplierId: 's1', amount: 5000, date: '2026-03-15', reference: 'INV-001' },
      { id: '2', supplierId: 's1', amount: 5000, date: '2026-03-15', reference: 'INV-001' },
    ];
    const result = detectDuplicatePayments(payments);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('detects near-duplicate (same amount + supplier, close dates)', () => {
    const payments = [
      { id: '1', supplierId: 's1', amount: 5000, date: '2026-03-15', reference: 'INV-001' },
      { id: '2', supplierId: 's1', amount: 5000, date: '2026-03-18', reference: 'INV-001' },
    ];
    const result = detectDuplicatePayments(payments);
    expect(result.length).toBeGreaterThan(0);
  });

  it('ignores different suppliers', () => {
    const payments = [
      { id: '1', supplierId: 's1', amount: 5000, date: '2026-03-15', reference: 'X' },
      { id: '2', supplierId: 's2', amount: 5000, date: '2026-03-15', reference: 'Y' },
    ];
    expect(detectDuplicatePayments(payments).length).toBe(0);
  });

  it('ignores different amounts', () => {
    const payments = [
      { id: '1', supplierId: 's1', amount: 5000, date: '2026-03-15', reference: 'X' },
      { id: '2', supplierId: 's1', amount: 6000, date: '2026-03-15', reference: 'Y' },
    ];
    expect(detectDuplicatePayments(payments).length).toBe(0);
  });

  it('handles empty list', () => {
    expect(detectDuplicatePayments([]).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// UNUSUAL POSTING PATTERNS
// ═══════════════════════════════════════════════════════════════════════════

describe('Unusual Posting Patterns', () => {
  it('flags weekend postings', () => {
    const entries = [
      { id: '1', date: '2026-03-28', amount: 5000, userId: 'u1', description: 'Weekend entry' }, // Saturday
    ];
    const result = detectUnusualPostingPatterns(entries);
    expect(result.some(r => r.type === 'weekend_posting')).toBe(true);
  });

  it('flags round number patterns', () => {
    const entries = Array(10).fill(0).map((_, i) => ({
      id: String(i), date: '2026-03-15', amount: (i + 1) * 10000, userId: 'u1', description: 'Round',
    }));
    const result = detectUnusualPostingPatterns(entries);
    expect(result.some(r => r.type === 'round_numbers')).toBe(true);
  });

  it('returns empty for normal entries', () => {
    const entries = [
      { id: '1', date: '2026-03-17', amount: 4523.67, userId: 'u1', description: 'Normal' }, // Tuesday
      { id: '2', date: '2026-03-18', amount: 8912.33, userId: 'u1', description: 'Normal' }, // Wednesday
    ];
    const result = detectUnusualPostingPatterns(entries);
    expect(result.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// JOURNAL ENTRY RISK SCORING
// ═══════════════════════════════════════════════════════════════════════════

describe('Journal Entry Risk Scoring', () => {
  it('scores low risk for normal entry', () => {
    const score = scoreJournalEntryRisk({
      amount: 5000, isManual: false, isWeekend: false, isRoundNumber: false,
      isNearPeriodEnd: false, hasDescription: true, lineCount: 2,
    });
    expect(score.score).toBeLessThan(30);
    expect(score.level).toBe('low');
  });

  it('scores high risk for suspicious entry', () => {
    const score = scoreJournalEntryRisk({
      amount: 99999, isManual: true, isWeekend: true, isRoundNumber: true,
      isNearPeriodEnd: true, hasDescription: false, lineCount: 2,
    });
    expect(score.score).toBeGreaterThan(60);
    expect(score.level).toBe('high');
  });

  it('penalizes missing description', () => {
    const withDesc = scoreJournalEntryRisk({ amount: 1000, isManual: true, isWeekend: false, isRoundNumber: false, isNearPeriodEnd: false, hasDescription: true, lineCount: 2 });
    const withoutDesc = scoreJournalEntryRisk({ amount: 1000, isManual: true, isWeekend: false, isRoundNumber: false, isNearPeriodEnd: false, hasDescription: false, lineCount: 2 });
    expect(withoutDesc.score).toBeGreaterThan(withDesc.score);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ALERT MESSAGE BUILDING
// ═══════════════════════════════════════════════════════════════════════════

describe('Alert Message Building', () => {
  it('builds critical alert', () => {
    const msg = buildAlertMessage('duplicate_payment', 'critical', { amount: 50000, supplier: 'ABC Corp' });
    expect(msg.severity).toBe('critical');
    expect(msg.title.length).toBeGreaterThan(0);
    expect(msg.description).toContain('50');
  });

  it('builds warning alert', () => {
    const msg = buildAlertMessage('unusual_amount', 'warning', { amount: 100000 });
    expect(msg.severity).toBe('warning');
  });

  it('builds info alert', () => {
    const msg = buildAlertMessage('round_number', 'info', { amount: 10000 });
    expect(msg.severity).toBe('info');
  });

  it('includes timestamp', () => {
    const msg = buildAlertMessage('test', 'info', {});
    expect(msg.timestamp).toBeDefined();
  });
});
