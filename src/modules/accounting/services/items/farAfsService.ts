/**
 * FAR AFS Service — Phase 3
 * Pure aggregation functions for AFS PPE movement note and deferred tax schedule.
 * Consumes asset_period_ledger data. No DB dependencies.
 */

import { calculateDeferredTax } from './farDepreciationService';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Asset state at prior year end — one row per asset. */
export interface AssetPriorYearSnapshot {
  assetId: string;
  ias16Group: string;
  cost: number;
  accDep: number;
  carryingAmount: number;
}

/** Aggregated movements for one asset during the current year. */
export interface AssetCurrentYearMovement {
  assetId: string;
  ias16Group: string;
  /** Cost of new assets acquired in the year. */
  additions: number;
  /** Cost of assets disposed in the year. */
  disposalCost: number;
  /** Accumulated depreciation removed on disposal. */
  disposalAccDep: number;
  /** Total policy depreciation charged in the year. */
  depreciationCharge: number;
}

/** IAS 16 PPE movement note — one row per group code. */
export interface PpeGroupMovement {
  ias16Group: string;
  // Cost movements
  openingCost: number;
  additions: number;
  disposalsCost: number;
  closingCost: number;
  // Accumulated depreciation
  openingAccDep: number;
  depreciationCharge: number;
  disposalsAccDep: number;
  closingAccDep: number;
  // Carrying amounts
  openingCarryingAmount: number;
  closingCarryingAmount: number;
}

/** Per-category row for deferred tax schedule. */
export interface DeferredTaxCategoryRow {
  categoryCode: string;
  categoryName: string;
  ias16Group: string;
  totalPolicyCA: number;
  totalTaxCA: number;
  deferredTaxRate: number;
}

export interface DeferredTaxGroupResult {
  categoryCode: string;
  categoryName: string;
  ias16Group: string;
  policyCarryingAmount: number;
  taxCarryingAmount: number;
  temporaryDifference: number;
  deferredTax: number;
  isLiability: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── PPE Movement Note Aggregation ───────────────────────────────────────────

/**
 * Aggregates IAS 16 PPE movement note data from prior-year snapshots and
 * current-year asset movements.
 *
 * Groups by ias16_group. Handles new assets (no prior-year snapshot) by
 * treating their opening balance as zero.
 */
export function aggregatePpeMovements(
  priorYearSnapshots: AssetPriorYearSnapshot[],
  currentYearMovements: AssetCurrentYearMovement[],
): PpeGroupMovement[] {
  // Build lookup for prior year state by assetId
  const priorByAsset = new Map<string, AssetPriorYearSnapshot>();
  for (const s of priorYearSnapshots) {
    priorByAsset.set(s.assetId, s);
  }

  // Accumulator keyed by ias16Group
  interface GroupAcc {
    openingCost: number;
    openingAccDep: number;
    openingCA: number;
    additions: number;
    disposalsCost: number;
    disposalsAccDep: number;
    depreciationCharge: number;
  }
  const groups = new Map<string, GroupAcc>();

  const ensureGroup = (code: string): GroupAcc => {
    if (!groups.has(code)) {
      groups.set(code, {
        openingCost: 0, openingAccDep: 0, openingCA: 0,
        additions: 0, disposalsCost: 0, disposalsAccDep: 0, depreciationCharge: 0,
      });
    }
    return groups.get(code)!;
  };

  // Seed opening balances from prior year snapshots
  for (const snap of priorYearSnapshots) {
    const g = ensureGroup(snap.ias16Group);
    g.openingCost += snap.cost;
    g.openingAccDep += snap.accDep;
    g.openingCA += snap.carryingAmount;
  }

  // Apply current year movements
  for (const mv of currentYearMovements) {
    const g = ensureGroup(mv.ias16Group);
    g.additions += mv.additions;
    g.disposalsCost += mv.disposalCost;
    g.disposalsAccDep += mv.disposalAccDep;
    g.depreciationCharge += mv.depreciationCharge;
  }

  // Build results
  const result: PpeGroupMovement[] = [];
  for (const [ias16Group, g] of groups) {
    const closingCost = round2(g.openingCost + g.additions - g.disposalsCost);
    const closingAccDep = round2(g.openingAccDep + g.depreciationCharge - g.disposalsAccDep);
    const closingCarryingAmount = round2(closingCost - closingAccDep);

    result.push({
      ias16Group,
      openingCost: round2(g.openingCost),
      additions: round2(g.additions),
      disposalsCost: round2(g.disposalsCost),
      closingCost,
      openingAccDep: round2(g.openingAccDep),
      depreciationCharge: round2(g.depreciationCharge),
      disposalsAccDep: round2(g.disposalsAccDep),
      closingAccDep,
      openingCarryingAmount: round2(g.openingCA),
      closingCarryingAmount,
    });
  }

  return result.sort((a, b) => a.ias16Group.localeCompare(b.ias16Group));
}

// ─── Deferred Tax Schedule ────────────────────────────────────────────────────

/**
 * Computes deferred tax schedule from per-category carrying amount totals.
 * Delegates the per-row math to calculateDeferredTax from farDepreciationService.
 */
export function aggregateDeferredTax(rows: DeferredTaxCategoryRow[]): DeferredTaxGroupResult[] {
  return rows.map(r => {
    const dt = calculateDeferredTax({
      policyCarryingAmount: r.totalPolicyCA,
      taxCarryingAmount: r.totalTaxCA,
      deferredTaxRate: r.deferredTaxRate,
    });
    return {
      categoryCode: r.categoryCode,
      categoryName: r.categoryName,
      ias16Group: r.ias16Group,
      policyCarryingAmount: r.totalPolicyCA,
      taxCarryingAmount: r.totalTaxCA,
      temporaryDifference: dt.temporaryDifference,
      deferredTax: dt.deferredTax,
      isLiability: dt.isLiability,
    };
  });
}
