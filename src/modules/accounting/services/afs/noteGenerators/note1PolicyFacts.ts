// src/modules/accounting/services/afs/noteGenerators/note1PolicyFacts.ts
// The company facts note 1's policy wording depends on, read from its records
// (there is no stored policy choice for either), and how they change the text.

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import { toDepreciationMethod, type DepreciationMethod } from '@/modules/accounting/services/items/depreciationMethods';
import { inventoryBalancesAt } from './inventoryBalances';

export interface PolicyFacts {
  /** Methods of the assets held at some point in the year, in a fixed order; empty when the register holds none. */
  depMethods: DepreciationMethod[];
  /** True when an inventory account carries a balance at the year end (note 9's test). */
  holdsInventory: boolean;
}

const METHOD_ORDER: DepreciationMethod[] = ['straight_line', 'reducing_balance', 'sum_of_years'];
const METHOD_WORDS: Record<DepreciationMethod, string> = {
  straight_line: 'straight-line',
  reducing_balance: 'reducing-balance',
  sum_of_years: "sum-of-the-years'-digits",
};

export async function readPolicyFacts(companyId: string, start: string, end: string): Promise<PolicyFacts> {
  // Held during the year: bought on or before its end, not disposed of before it began.
  const rows = (await sql`
    SELECT DISTINCT depreciation_method FROM assets
    WHERE company_id = ${companyId}
      AND purchase_date <= ${end}::DATE
      AND (disposal_date IS NULL OR disposal_date >= ${start}::DATE)
  `) as DbRow[];
  const found = new Set(rows.map((r) => toDepreciationMethod(r.depreciation_method)));
  return {
    depMethods: METHOD_ORDER.filter((m) => found.has(m)),
    holdsInventory: (await inventoryBalancesAt(companyId, end)).length > 0,
  };
}

/**
 * The policies with the facts applied: the depreciation sentence names the methods in use
 * ("the straight-line or reducing-balance method, as set for each asset,"), and the
 * inventories policy is left out when there is no inventory. With no assets the framework's
 * default wording stays.
 */
export function applyPolicyFacts(
  policies: Array<{ heading: string; text: string }>,
  facts: PolicyFacts,
): Array<{ heading: string; text: string }> {
  const out = facts.holdsInventory ? policies : policies.filter((p) => p.heading !== 'Inventories');
  if (facts.depMethods.length === 0) return out;
  const words = facts.depMethods.map((m) => METHOD_WORDS[m]);
  const named = words.length === 1
    ? `the ${words[0]} method`
    : `the ${words.slice(0, -1).join(', ')} or ${words[words.length - 1]} method, as set for each asset,`;
  return out.map((p) => (p.heading === 'Property, Plant and Equipment'
    ? { ...p, text: p.text.replace('the straight-line method', named) }
    : p));
}
