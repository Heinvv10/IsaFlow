/**
 * FAR Disposal Service — Phase 2
 * Pure business logic for asset disposals: gain/loss calculation, SARS recoupment
 * detection, and journal line building. No DB dependencies.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DisposalCalculationInput {
  cost: number;
  /** Policy (IAS 16) accumulated depreciation at disposal date. */
  policyAccDep: number;
  /** Tax (SARS) accumulated depreciation at disposal date. */
  taxAccDep: number;
  /** Net proceeds received on disposal. */
  proceeds: number;
}

export interface DisposalCalculationResult {
  policyCarryingAmount: number;
  taxCarryingAmount: number;
  /** proceeds − policy CA: positive = gain, negative = loss. */
  policyGainLoss: number;
  /** proceeds − tax CA: positive = gain, negative = loss. */
  taxGainLoss: number;
  /**
   * SARS recoupment: taxable income when disposal proceeds exceed the tax
   * carrying amount. Capped at tax accumulated depreciation (cannot recoup
   * more than was ever claimed as a deduction).
   */
  recoupment: number;
  /** True when taxGainLoss > 0 (i.e. recoupment applies). */
  hasRecoupment: boolean;
  /** Capital gain portion: policyGainLoss above the recoupment already covered. */
  capitalGain: number;
}

/** Roles that the GL posting hook resolves to real account IDs. */
export type JournalAccountRole =
  | 'accumulated_depreciation'
  | 'fixed_asset'
  | 'bank'
  | 'disposal_profit_loss'
  | 'default_expense';

export interface JournalLineSpec {
  accountRole: JournalAccountRole;
  debit: number;
  credit: number;
  description: string;
}

export interface DisposalJournalInput {
  assetNumber: string;
  assetName: string;
  cost: number;
  /** Policy accumulated depreciation at disposal date. */
  policyAccDep: number;
  /** Signed gain/loss: positive = gain (credit P&L), negative = loss (debit P&L). */
  gainLoss: number;
  proceeds: number;
}

export interface CapitalizationJournalInput {
  assetNumber: string;
  assetName: string;
  cost: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Disposal Calculation ─────────────────────────────────────────────────────

/**
 * Calculates all disposal figures needed for GL posting and AFS disclosure.
 *
 * SARS recoupment logic (Section 8(4)(a)):
 *   recoupment = min(taxGainLoss, taxAccDep)
 *   - Cannot recoup more than was claimed as a tax deduction
 *   - Any proceeds above cost are capital gains, not recoupment
 */
export function calculateDisposalResult(input: DisposalCalculationInput): DisposalCalculationResult {
  const { cost, policyAccDep, taxAccDep, proceeds } = input;

  const policyCarryingAmount = round2(cost - policyAccDep);
  const taxCarryingAmount = round2(cost - taxAccDep);

  const policyGainLoss = round2(proceeds - policyCarryingAmount);
  const taxGainLoss = round2(proceeds - taxCarryingAmount);

  const hasRecoupment = taxGainLoss > 0;
  // Recoupment = amount of prior tax deductions being "clawed back"
  const recoupment = hasRecoupment ? round2(Math.min(taxGainLoss, taxAccDep)) : 0;

  // Capital gain = policy gain above what recoupment already accounts for
  // Only arises when the asset is sold for more than its policy CA AND more than
  // what recoupment covers.
  const capitalGain = round2(Math.max(0, policyGainLoss - recoupment));

  return {
    policyCarryingAmount,
    taxCarryingAmount,
    policyGainLoss,
    taxGainLoss,
    recoupment,
    hasRecoupment,
    capitalGain,
  };
}

// ─── Disposal Journal Line Building ──────────────────────────────────────────

/**
 * Builds the journal line specs for an asset disposal.
 *
 * Standard disposal entry:
 *   Dr  Accumulated Depreciation   (policy acc dep removed)
 *   Dr  Bank                       (proceeds received — if > 0)
 *   Dr  Loss on Disposal           (if loss — policyGainLoss < 0)
 *   Cr  Fixed Asset at Cost        (cost removed from BS)
 *   Cr  Profit on Disposal         (if gain — policyGainLoss > 0)
 */
export function buildDisposalJournalLines(input: DisposalJournalInput): JournalLineSpec[] {
  const { assetNumber, assetName, cost, policyAccDep, gainLoss, proceeds } = input;
  const tag = `${assetName} (${assetNumber})`;
  const lines: JournalLineSpec[] = [];

  // Dr Accumulated Depreciation
  if (policyAccDep > 0) {
    lines.push({
      accountRole: 'accumulated_depreciation',
      debit: round2(policyAccDep),
      credit: 0,
      description: `Disposal acc dep: ${tag}`,
    });
  }

  // Dr Bank (proceeds received)
  if (proceeds > 0) {
    lines.push({
      accountRole: 'bank',
      debit: round2(proceeds),
      credit: 0,
      description: `Disposal proceeds: ${tag}`,
    });
  }

  // Dr/Cr Profit or Loss on Disposal
  if (gainLoss < 0) {
    // Loss → debit the P&L account
    lines.push({
      accountRole: 'disposal_profit_loss',
      debit: round2(Math.abs(gainLoss)),
      credit: 0,
      description: `Loss on disposal: ${tag}`,
    });
  } else if (gainLoss > 0) {
    // Gain → credit the P&L account
    lines.push({
      accountRole: 'disposal_profit_loss',
      debit: 0,
      credit: round2(gainLoss),
      description: `Gain on disposal: ${tag}`,
    });
  }

  // Cr Fixed Asset at Cost
  lines.push({
    accountRole: 'fixed_asset',
    debit: 0,
    credit: round2(cost),
    description: `Disposal asset cost: ${tag}`,
  });

  return lines;
}

// ─── Capitalization Threshold Journal Building ────────────────────────────────

/**
 * Builds the journal line specs when a below-threshold asset is expensed
 * immediately instead of being capitalised.
 *
 * Entry:
 *   Dr  Default Expense  (cost to P&L immediately)
 *   Cr  Bank             (payment assumed from bank)
 */
export function buildCapitalizationJournalLines(input: CapitalizationJournalInput): JournalLineSpec[] {
  const { assetNumber, assetName, cost } = input;
  const tag = `${assetName} (${assetNumber})`;

  return [
    {
      accountRole: 'default_expense',
      debit: round2(cost),
      credit: 0,
      description: `Below-threshold expense: ${tag}`,
    },
    {
      accountRole: 'bank',
      debit: 0,
      credit: round2(cost),
      description: `Below-threshold expense: ${tag}`,
    },
  ];
}
