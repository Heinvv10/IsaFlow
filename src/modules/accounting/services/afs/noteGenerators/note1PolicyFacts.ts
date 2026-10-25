// src/modules/accounting/services/afs/noteGenerators/note1PolicyFacts.ts
// The company facts note 1's policy wording depends on, read from its records
// (companies stores no policy choice), and how they change the text.

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import { toDepreciationMethod, type DepreciationMethod } from '@/modules/accounting/services/items/depreciationMethods';
import type { CostMethod } from '@/modules/accounting/services/items/inventoryService';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import { INVENTORY_SUBTYPES, inventoryBalancesAt } from './inventoryBalances';

export interface PolicyFacts {
  /** Methods of the assets held at some point in the year, in a fixed order; empty when the register holds none. */
  depMethods: DepreciationMethod[];
  /** Cost methods of the active inventory products (all of them when none is active), in a fixed order; empty when there are none. */
  invMethods: CostMethod[];
  /** Inventory at some point in the year: a balance at the prior year end, or a posted movement in the year. */
  holdsInventory: boolean;
}

const DEP_ORDER: DepreciationMethod[] = ['straight_line', 'reducing_balance', 'sum_of_years'];
const DEP_WORDS: Record<DepreciationMethod, string> = {
  straight_line: 'straight-line',
  reducing_balance: 'reducing-balance',
  sum_of_years: "sum-of-the-years'-digits",
};
const COST_ORDER: CostMethod[] = ['weighted_average', 'fifo'];
const COST_WORDS: Record<CostMethod, string> = {
  weighted_average: 'weighted average cost',
  fifo: 'first-in, first-out (FIFO)',
};

/** The calendar day before an ISO date. */
function dayBefore(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function readPolicyFacts(companyId: string, start: string, end: string): Promise<PolicyFacts> {
  // Held during the year: bought on or before its end, not disposed of before it began.
  const assets = (await sql`
    SELECT DISTINCT depreciation_method FROM assets
    WHERE company_id = ${companyId}
      AND purchase_date <= ${end}::DATE
      AND (disposal_date IS NULL OR disposal_date >= ${start}::DATE)
  `) as DbRow[];
  // The active inventory products; when none is active (stock sold out and the items retired), all of them.
  const products = (await sql`
    SELECT DISTINCT cost_method FROM products p
    WHERE p.company_id = ${companyId} AND p.product_type = 'inventory'
      AND (p.is_active = true OR NOT EXISTS (
        SELECT 1 FROM products a WHERE a.company_id = ${companyId} AND a.product_type = 'inventory' AND a.is_active = true))
  `) as DbRow[];
  const moved = (await sql`
    SELECT EXISTS (
      SELECT 1 FROM gl_journal_lines gjl
      JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = gjl.gl_account_id AND ga.company_id = ${companyId}
      WHERE gjl.company_id = ${companyId}
        AND ga.account_subtype = ANY(${INVENTORY_SUBTYPES}::TEXT[])
        AND gje.status = 'posted' AND gje.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        AND gje.entry_date BETWEEN ${start}::DATE AND ${end}::DATE
    ) AS moved
  `) as DbRow[];
  const depFound = new Set(assets.map((r) => toDepreciationMethod(r.depreciation_method)));
  const costFound = new Set(products.map((r) => String(r.cost_method)));
  return {
    depMethods: DEP_ORDER.filter((m) => depFound.has(m)),
    invMethods: COST_ORDER.filter((m) => costFound.has(m)),
    holdsInventory: moved[0]?.moved === true || (await inventoryBalancesAt(companyId, dayBefore(start))).length > 0,
  };
}

/**
 * `text` with `phrase` ("the straight-line method") replaced by the methods in use: "the X method",
 * or "the X or Y method, as set for each <unit>" when several are, followed by a comma unless the
 * phrase ends its sentence.
 */
function nameMethods(text: string, phrase: string, words: string[], unit: string): string {
  const at = text.indexOf(phrase);
  if (at < 0) return text;
  const after = text.slice(at + phrase.length);
  const named = words.length === 1
    ? `the ${words[0]} method`
    : `the ${words.slice(0, -1).join(', ')} or ${words[words.length - 1]} method, as set for each ${unit}${after.startsWith('.') ? '' : ','}`;
  return text.slice(0, at) + named + after;
}

/**
 * The policies with the facts applied: the depreciation and inventory cost sentences name the
 * methods in use, and the inventories policy is left out when the company held no inventory in
 * the year. With no assets (or no inventory products) the framework's default wording stays.
 */
export function applyPolicyFacts(
  policies: Array<{ heading: string; text: string }>,
  facts: PolicyFacts,
): Array<{ heading: string; text: string }> {
  const out = facts.holdsInventory ? policies : policies.filter((p) => p.heading !== 'Inventories');
  return out.map((p) => {
    if (p.heading === 'Property, Plant and Equipment' && facts.depMethods.length > 0) {
      return { ...p, text: nameMethods(p.text, 'the straight-line method', facts.depMethods.map((m) => DEP_WORDS[m]), 'asset') };
    }
    if (p.heading === 'Inventories' && facts.invMethods.length > 0) {
      return { ...p, text: nameMethods(p.text, 'the weighted average cost method', facts.invMethods.map((m) => COST_WORDS[m]), 'item') };
    }
    return p;
  });
}
