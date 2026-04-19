import { describe, it, expect } from 'vitest';
import {
  calculateDisposalResult,
  buildDisposalJournalLines,
  buildCapitalizationJournalLines,
  type DisposalCalculationInput,
  type DisposalJournalInput,
  type CapitalizationJournalInput,
} from '@/modules/accounting/services/items/farDisposalService';

// ─── Disposal Gain / Loss / Recoupment ───────────────────────────────────────

describe('calculateDisposalResult', () => {
  it('calculates policy gain when proceeds exceed policy carrying amount', () => {
    const input: DisposalCalculationInput = {
      cost: 100_000,
      policyAccDep: 80_000,   // policy CA = 20 000
      taxAccDep: 100_000,     // fully written off for tax
      proceeds: 35_000,
    };
    const result = calculateDisposalResult(input);
    expect(result.policyCarryingAmount).toBe(20_000);
    expect(result.policyGainLoss).toBe(15_000); // 35k − 20k = gain
  });

  it('calculates policy loss when proceeds are below policy carrying amount', () => {
    const input: DisposalCalculationInput = {
      cost: 100_000,
      policyAccDep: 40_000,   // policy CA = 60 000
      taxAccDep: 80_000,      // tax CA = 20 000
      proceeds: 50_000,
    };
    const result = calculateDisposalResult(input);
    expect(result.policyGainLoss).toBe(-10_000); // loss
  });

  it('calculates tax gain when proceeds exceed tax carrying amount', () => {
    const input: DisposalCalculationInput = {
      cost: 100_000,
      policyAccDep: 60_000,
      taxAccDep: 90_000,      // tax CA = 10 000
      proceeds: 40_000,
    };
    const result = calculateDisposalResult(input);
    expect(result.taxCarryingAmount).toBe(10_000);
    expect(result.taxGainLoss).toBe(30_000); // 40k − 10k
  });

  it('detects SARS recoupment when tax gain is positive', () => {
    // Recoupment = min(taxGainLoss, taxAccDep) — cannot exceed what was claimed as tax dep
    const input: DisposalCalculationInput = {
      cost: 100_000,
      policyAccDep: 60_000,
      taxAccDep: 90_000,
      proceeds: 40_000,
    };
    const result = calculateDisposalResult(input);
    // taxGainLoss = 40 000 − 10 000 = 30 000
    // recoupment = min(30 000, 90 000) = 30 000
    expect(result.hasRecoupment).toBe(true);
    expect(result.recoupment).toBe(30_000);
  });

  it('caps recoupment at tax accumulated depreciation', () => {
    // Scenario: asset sold for more than cost (unlikely but must not exceed taxAccDep)
    const input: DisposalCalculationInput = {
      cost: 100_000,
      policyAccDep: 20_000,
      taxAccDep: 30_000,      // only 30k was ever claimed
      proceeds: 150_000,      // sold for more than cost
    };
    const result = calculateDisposalResult(input);
    // recoupment cannot exceed taxAccDep (30 000)
    expect(result.recoupment).toBe(30_000);
  });

  it('sets recoupment to zero when no tax gain', () => {
    const input: DisposalCalculationInput = {
      cost: 100_000,
      policyAccDep: 40_000,
      taxAccDep: 40_000,
      proceeds: 5_000,       // below both CAs → loss
    };
    const result = calculateDisposalResult(input);
    expect(result.hasRecoupment).toBe(false);
    expect(result.recoupment).toBe(0);
  });

  it('calculates capital gain as policyGainLoss beyond recoupment', () => {
    // When policy gain > recoupment, excess is a capital gain
    const input: DisposalCalculationInput = {
      cost: 100_000,
      policyAccDep: 90_000,   // policy CA = 10 000
      taxAccDep: 100_000,     // fully written off for tax
      proceeds: 60_000,
    };
    const result = calculateDisposalResult(input);
    // policyGainLoss = 60 000 − 10 000 = 50 000
    // recoupment = min(50 000, 100 000) = capped to taxGainLoss = 60 000 − 0 = 60 000 → min(60k, 100k) = 60k
    // But capital gain: policyGainLoss (50k) − recoupment portion above taxAccDep
    // recoupment = min(taxGainLoss, taxAccDep) = min(60k, 100k) = 60k → but capped at proceeds too
    // Let me redo: policy CA = 10 000; tax CA = 0; proceeds = 60 000
    // policyGainLoss = 50 000; taxGainLoss = 60 000
    // recoupment = min(60 000, 100 000) = 60 000 but cannot exceed proceeds = 60 000 ✓
    // capital gain = max(0, policyGainLoss − recoupment) = max(0, 50 000 − 60 000) = 0
    // (recoupment already covers all policy gain)
    expect(result.capitalGain).toBe(0);
    expect(result.recoupment).toBe(60_000);
  });

  it('returns zero values when proceeds equal policy carrying amount (break-even)', () => {
    const input: DisposalCalculationInput = {
      cost: 50_000,
      policyAccDep: 30_000,   // policy CA = 20 000
      taxAccDep: 40_000,      // tax CA = 10 000
      proceeds: 20_000,
    };
    const result = calculateDisposalResult(input);
    expect(result.policyGainLoss).toBe(0);
  });

  it('handles write-off disposal (proceeds = 0)', () => {
    const input: DisposalCalculationInput = {
      cost: 80_000,
      policyAccDep: 60_000,   // policy CA = 20 000
      taxAccDep: 80_000,      // fully written off for tax
      proceeds: 0,
    };
    const result = calculateDisposalResult(input);
    expect(result.policyGainLoss).toBe(-20_000); // loss on disposal
    expect(result.taxGainLoss).toBe(0);          // tax CA = 0, no gain/loss
    expect(result.hasRecoupment).toBe(false);
    expect(result.recoupment).toBe(0);
  });
});

// ─── Disposal Journal Line Building ──────────────────────────────────────────

describe('buildDisposalJournalLines', () => {
  it('builds correct journal lines for a disposal with proceeds', () => {
    const input: DisposalJournalInput = {
      assetNumber: 'CE-0001',
      assetName: 'Dell Laptop',
      cost: 100_000,
      policyAccDep: 80_000,
      gainLoss: 5_000, // gain
      proceeds: 25_000,
    };
    const lines = buildDisposalJournalLines(input);

    // Must include: Dr Acc Dep, Cr Asset Cost, Dr Bank, Cr Disposal P&L (gain)
    const accumDepLine = lines.find(l => l.accountRole === 'accumulated_depreciation');
    const assetCostLine = lines.find(l => l.accountRole === 'fixed_asset');
    const bankLine = lines.find(l => l.accountRole === 'bank');
    const plLine = lines.find(l => l.accountRole === 'disposal_profit_loss');

    expect(accumDepLine?.debit).toBeCloseTo(80_000, 2);
    expect(assetCostLine?.credit).toBeCloseTo(100_000, 2);
    expect(bankLine?.debit).toBeCloseTo(25_000, 2);
    expect(plLine?.credit).toBeCloseTo(5_000, 2); // gain → credit
  });

  it('builds loss-side disposal journal (Dr disposal P&L, not Cr)', () => {
    const input: DisposalJournalInput = {
      assetNumber: 'MV-0001',
      assetName: 'Toyota Hilux',
      cost: 300_000,
      policyAccDep: 100_000,
      gainLoss: -50_000,  // loss
      proceeds: 150_000,
    };
    const lines = buildDisposalJournalLines(input);
    const plLine = lines.find(l => l.accountRole === 'disposal_profit_loss');
    // Loss → debit the P&L account
    expect(plLine?.debit).toBeCloseTo(50_000, 2);
    expect(plLine?.credit).toBe(0);
  });

  it('builds write-off journal with zero proceeds', () => {
    const input: DisposalJournalInput = {
      assetNumber: 'FF-0010',
      assetName: 'Office Chair',
      cost: 5_000,
      policyAccDep: 3_000,
      gainLoss: -2_000,
      proceeds: 0,
    };
    const lines = buildDisposalJournalLines(input);
    const bankLine = lines.find(l => l.accountRole === 'bank');
    expect(bankLine).toBeUndefined(); // no bank line when proceeds = 0
  });

  it('produces balanced journal (total debits = total credits)', () => {
    const input: DisposalJournalInput = {
      assetNumber: 'CE-0002',
      assetName: 'Server',
      cost: 200_000,
      policyAccDep: 150_000,
      gainLoss: 30_000,
      proceeds: 80_000,
    };
    const lines = buildDisposalJournalLines(input);
    const totalDebit = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    const totalCredit = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 2);
  });
});

// ─── Capitalization Threshold Journal Building ────────────────────────────────

describe('buildCapitalizationJournalLines', () => {
  it('builds Dr expense / Cr bank lines for below-threshold asset', () => {
    const input: CapitalizationJournalInput = {
      assetNumber: 'ASST-0001',
      assetName: 'Staple Gun',
      cost: 499,
    };
    const lines = buildCapitalizationJournalLines(input);
    const expenseLine = lines.find(l => l.accountRole === 'default_expense');
    const bankLine = lines.find(l => l.accountRole === 'bank');

    expect(expenseLine?.debit).toBeCloseTo(499, 2);
    expect(bankLine?.credit).toBeCloseTo(499, 2);
  });

  it('produces balanced journal for capitalization expense', () => {
    const input: CapitalizationJournalInput = {
      assetNumber: 'ASST-0002',
      assetName: 'Calculator',
      cost: 350,
    };
    const lines = buildCapitalizationJournalLines(input);
    const totalDebit = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    const totalCredit = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 2);
  });
});
