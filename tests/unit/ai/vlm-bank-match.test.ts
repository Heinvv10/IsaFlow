/**
 * TDD: VLM-Enhanced Bank Reconciliation Matching
 */

import { describe, it, expect } from 'vitest';
import {
  parseBankDescriptionResponse,
  enhanceMatchWithVlm,
  buildEnhancedMatchCandidates,
  type ParsedBankDescription,
  type VlmMatchResult,
} from '@/modules/accounting/services/vlmBankMatchService';

describe('Bank Description Response Parsing', () => {
  it('parses vendor name from response', () => {
    const r = parseBankDescriptionResponse('{"vendorName":"Makro SA","invoiceRef":"MKR-001","paymentType":"EFT"}');
    expect(r).not.toBeNull();
    expect(r!.vendorName).toBe('Makro SA');
  });

  it('parses invoice reference', () => {
    const r = parseBankDescriptionResponse('{"vendorName":"Telkom","invoiceRef":"TLK-2026-1234","paymentType":"debit_order"}');
    expect(r!.invoiceRef).toBe('TLK-2026-1234');
  });

  it('parses payment type', () => {
    const r = parseBankDescriptionResponse('{"vendorName":"Engen","invoiceRef":null,"paymentType":"POS"}');
    expect(r!.paymentType).toBe('POS');
  });

  it('handles null fields', () => {
    const r = parseBankDescriptionResponse('{"vendorName":null,"customerName":"VelocityFibre","invoiceRef":null,"paymentType":null}');
    expect(r!.vendorName).toBeNull();
    expect(r!.customerName).toBe('VelocityFibre');
  });

  it('handles malformed JSON', () => {
    expect(parseBankDescriptionResponse('not json')).toBeNull();
  });

  it('strips VLM thinking tags', () => {
    const r = parseBankDescriptionResponse('<think>reasoning here</think>{"vendorName":"Test","invoiceRef":null,"paymentType":null}');
    expect(r).not.toBeNull();
    expect(r!.vendorName).toBe('Test');
  });
});

describe('Enhanced Match with VLM', () => {
  const suppliers = [
    { id: 'sup-1', name: 'Makro SA (Pty) Ltd' },
    { id: 'sup-2', name: 'Telkom SA SOC Ltd' },
  ];
  const clients = [
    { id: 'cli-1', name: 'VelocityFibre (Pty) Ltd' },
  ];

  it('matches extracted vendor against supplier list', () => {
    const parsed: ParsedBankDescription = { vendorName: 'Makro SA', customerName: null, invoiceRef: null, paymentType: null };
    const r = enhanceMatchWithVlm(parsed, suppliers, clients);
    expect(r).not.toBeNull();
    expect(r!.entityId).toBe('sup-1');
    expect(r!.entityType).toBe('supplier');
  });

  it('matches extracted customer against client list', () => {
    const parsed: ParsedBankDescription = { vendorName: null, customerName: 'VelocityFibre', invoiceRef: null, paymentType: null };
    const r = enhanceMatchWithVlm(parsed, suppliers, clients);
    expect(r).not.toBeNull();
    expect(r!.entityId).toBe('cli-1');
    expect(r!.entityType).toBe('customer');
  });

  it('returns null when no entity matches', () => {
    const parsed: ParsedBankDescription = { vendorName: 'Unknown Corp', customerName: null, invoiceRef: null, paymentType: null };
    expect(enhanceMatchWithVlm(parsed, suppliers, clients)).toBeNull();
  });

  it('returns confidence score', () => {
    const parsed: ParsedBankDescription = { vendorName: 'Makro SA', customerName: null, invoiceRef: null, paymentType: null };
    const r = enhanceMatchWithVlm(parsed, suppliers, clients);
    expect(r!.score).toBeGreaterThan(0.5);
  });
});

describe('Enhanced Match Candidates', () => {
  const invoices = [
    { id: 'inv-1', entityId: 'sup-1', amount: 10000, reference: 'MKR-001', date: '2026-03-01' },
    { id: 'inv-2', entityId: 'sup-1', amount: 5000, reference: 'MKR-002', date: '2026-03-10' },
    { id: 'inv-3', entityId: 'sup-2', amount: 10000, reference: 'TLK-001', date: '2026-03-05' },
  ];

  it('finds outstanding invoice by amount for matched supplier', () => {
    const vlmResult: VlmMatchResult = { entityId: 'sup-1', entityName: 'Makro', entityType: 'supplier', score: 0.9 };
    const bankTx = { id: 'tx-1', amount: -10000, date: '2026-03-05', reference: '', description: '' };
    const candidates = buildEnhancedMatchCandidates(bankTx, vlmResult, invoices);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.invoiceId).toBe('inv-1');
  });

  it('finds invoice by extracted reference', () => {
    const vlmResult: VlmMatchResult = { entityId: 'sup-1', entityName: 'Makro', entityType: 'supplier', score: 0.9 };
    const bankTx = { id: 'tx-1', amount: -5000, date: '2026-03-15', reference: 'MKR-002', description: '' };
    const candidates = buildEnhancedMatchCandidates(bankTx, vlmResult, invoices);
    expect(candidates.some(c => c.invoiceId === 'inv-2')).toBe(true);
  });

  it('returns higher confidence than 0.7 (generic amount-only)', () => {
    const vlmResult: VlmMatchResult = { entityId: 'sup-1', entityName: 'Makro', entityType: 'supplier', score: 0.9 };
    const bankTx = { id: 'tx-1', amount: -10000, date: '2026-03-05', reference: '', description: '' };
    const candidates = buildEnhancedMatchCandidates(bankTx, vlmResult, invoices);
    expect(candidates[0]!.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('returns empty when no invoice matches amount', () => {
    const vlmResult: VlmMatchResult = { entityId: 'sup-1', entityName: 'Makro', entityType: 'supplier', score: 0.9 };
    const bankTx = { id: 'tx-1', amount: -99999, date: '2026-03-05', reference: '', description: '' };
    const candidates = buildEnhancedMatchCandidates(bankTx, vlmResult, invoices);
    expect(candidates.length).toBe(0);
  });
});
