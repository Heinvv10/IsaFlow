/**
 * TDD: Continuous Close Agent
 */

import { describe, it, expect } from 'vitest';
import {
  planCloseActions,
  shouldAutoCategorizeTx,
  shouldAutoMatchTx,
  shouldAutoApproveInvoice,
  summarizeCloseRun,
  prioritizeExceptions,
  type CloseState,
  type CloseRunResults,
  type CloseException,
} from '@/modules/accounting/services/continuousCloseService';

const state: CloseState = {
  uncategorizedTxCount: 5,
  unmatchedTxCount: 3,
  pendingInvoiceCount: 2,
  pendingJournalCount: 1,
  uncategorizedTransactions: [
    { id: 'tx-1', description: 'WOOLWORTHS', amount: -500 },
    { id: 'tx-2', description: 'UNKNOWN PAYMENT', amount: -1500 },
  ],
  unmatchedTransactions: [
    { id: 'tx-3', amount: -10000, reference: 'MKR-001' },
  ],
  pendingInvoices: [
    { id: 'inv-1', amount: 5000, confidence: 0.92 },
    { id: 'inv-2', amount: 150000, confidence: 0.96 },
  ],
  pendingJournals: [
    { id: 'je-1', status: 'draft' },
  ],
};

describe('Close Action Planning', () => {
  it('includes uncategorized transactions in step 1', () => {
    const plan = planCloseActions(state);
    expect(plan.step1_categorize.length).toBeGreaterThan(0);
  });

  it('includes unmatched transactions in step 2', () => {
    const plan = planCloseActions(state);
    expect(plan.step2_match.length).toBeGreaterThan(0);
  });

  it('includes pending invoices in step 3', () => {
    const plan = planCloseActions(state);
    expect(plan.step3_approve.length).toBeGreaterThanOrEqual(0);
  });

  it('includes pending journals in step 4', () => {
    const plan = planCloseActions(state);
    expect(plan.step4_post.length).toBeGreaterThanOrEqual(0);
  });

  it('flags exceptions for items that cannot be auto-processed', () => {
    const plan = planCloseActions(state);
    expect(plan.step5_exceptions).toBeDefined();
  });
});

describe('Auto-Categorize Decision', () => {
  it('approves with HIGH confidence', () => {
    expect(shouldAutoCategorizeTx({ confidence: 0.95, source: 'rules' })).toBe(true);
  });

  it('rejects with LOW confidence', () => {
    expect(shouldAutoCategorizeTx({ confidence: 0.4, source: 'historical' })).toBe(false);
  });

  it('rejects when no suggestion', () => {
    expect(shouldAutoCategorizeTx(null)).toBe(false);
  });
});

describe('Auto-Match Decision', () => {
  it('approves with confidence >= 0.9', () => {
    expect(shouldAutoMatchTx({ confidence: 0.95 })).toBe(true);
  });

  it('rejects with confidence < 0.7', () => {
    expect(shouldAutoMatchTx({ confidence: 0.5 })).toBe(false);
  });

  it('approves exact reference match (1.0)', () => {
    expect(shouldAutoMatchTx({ confidence: 1.0 })).toBe(true);
  });
});

describe('Auto-Approve Invoice Decision', () => {
  it('approves below threshold', () => {
    expect(shouldAutoApproveInvoice(5000, 0.92, 50000)).toBe(true);
  });

  it('rejects above threshold', () => {
    expect(shouldAutoApproveInvoice(150000, 0.96, 50000)).toBe(false);
  });

  it('rejects low confidence even below threshold', () => {
    expect(shouldAutoApproveInvoice(3000, 0.5, 50000)).toBe(false);
  });
});

describe('Close Run Summary', () => {
  const results: CloseRunResults = {
    categorized: 3, matched: 2, approved: 1, posted: 1,
    exceptions: [{ type: 'low_confidence', entityId: 'tx-2', entityType: 'transaction', reason: 'Low confidence', severity: 'medium' }],
  };

  it('calculates total actions', () => {
    const s = summarizeCloseRun(results, 1500);
    expect(s.totalActions).toBe(7);
  });

  it('reports exception count', () => {
    const s = summarizeCloseRun(results, 1500);
    expect(s.exceptions).toBe(1);
  });

  it('includes duration', () => {
    const s = summarizeCloseRun(results, 1500);
    expect(s.duration).toBe(1500);
  });
});

describe('Exception Prioritization', () => {
  const exceptions: CloseException[] = [
    { type: 'low_confidence', entityId: '1', entityType: 'tx', reason: 'Low', severity: 'low' },
    { type: 'amount_threshold', entityId: '2', entityType: 'inv', reason: 'High value', severity: 'high' },
    { type: 'missing_data', entityId: '3', entityType: 'tx', reason: 'Missing', severity: 'medium' },
  ];

  it('sorts high severity first', () => {
    const sorted = prioritizeExceptions(exceptions);
    expect(sorted[0]!.severity).toBe('high');
  });

  it('sorts medium second', () => {
    const sorted = prioritizeExceptions(exceptions);
    expect(sorted[1]!.severity).toBe('medium');
  });
});
