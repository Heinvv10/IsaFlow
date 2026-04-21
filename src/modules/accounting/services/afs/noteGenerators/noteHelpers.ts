// src/modules/accounting/services/afs/noteGenerators/noteHelpers.ts
// Shared helpers for AFS note generators — DRY helpers + AFS mapping integration

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';

// ── Formatting ──────────────────────────────────────────────────────────────

export function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function toNum(v: unknown): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

export function fiscalRange(year: number): { start: string; end: string } {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

// ── AFS Mapping Integration ──────────────────────────────────────────────────

export interface AfsLineBalance {
  afsLineCode: string;
  label: string;
  noteNumber: number | null;
  combineGroup: string | null;
  currentAmount: number;
  priorAmount: number;
}

/**
 * Fetch GL balances aggregated by AFS line code for a specific note number.
 * Uses the Phase 1 afs_account_mappings + afs_statement_lines tables.
 * Falls back to empty array if no mappings exist (generators should use their own GL queries as fallback).
 */
export async function fetchBalancesByNote(
  companyId: string,
  noteNumber: number,
  fiscalYear: number,
  priorYear?: number,
): Promise<AfsLineBalance[]> {
  const { start, end } = fiscalRange(fiscalYear);
  const priorStart = priorYear ? `${priorYear}-01-01` : null;
  const priorEnd = priorYear ? `${priorYear}-12-31` : null;

  const rows = (await sql`
    SELECT
      sl.code AS afs_line_code,
      sl.label,
      sl.note_number,
      sl.combine_group,
      COALESCE(SUM(
        CASE WHEN gje.entry_date BETWEEN ${start} AND ${end}
             THEN gjl.debit - gjl.credit ELSE 0 END
      ), 0) AS current_amount,
      COALESCE(SUM(
        CASE WHEN ${priorStart}::DATE IS NOT NULL
             AND gje.entry_date BETWEEN ${priorStart} AND ${priorEnd}
             THEN gjl.debit - gjl.credit ELSE 0 END
      ), 0) AS prior_amount
    FROM afs_statement_lines sl
    JOIN afs_account_mappings am ON am.afs_line_code = sl.code AND am.company_id = sl.company_id
    JOIN gl_journal_lines gjl ON gjl.gl_account_id = am.gl_account_id AND gjl.company_id = ${companyId}
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id AND gje.status = 'posted'
    WHERE sl.company_id = ${companyId}
      AND sl.note_number = ${noteNumber}
      AND sl.is_active = true
    GROUP BY sl.code, sl.label, sl.note_number, sl.combine_group, sl.sort_order
    ORDER BY sl.sort_order
  `) as DbRow[];

  return rows.map((r) => ({
    afsLineCode: String(r.afs_line_code ?? ''),
    label: String(r.label ?? ''),
    noteNumber: r.note_number != null ? Number(r.note_number) : null,
    combineGroup: r.combine_group != null ? String(r.combine_group) : null,
    currentAmount: toNum(r.current_amount),
    priorAmount: toNum(r.prior_amount),
  }));
}

/**
 * Fetch GL balances aggregated by AFS line code for a set of line codes.
 * Useful when a generator knows which codes it needs (e.g., BS060-BS065 for receivables).
 */
export async function fetchBalancesByCodes(
  companyId: string,
  codes: string[],
  fiscalYear: number,
  priorYear?: number,
): Promise<AfsLineBalance[]> {
  if (codes.length === 0) return [];

  const { start, end } = fiscalRange(fiscalYear);
  const priorStart = priorYear ? `${priorYear}-01-01` : null;
  const priorEnd = priorYear ? `${priorYear}-12-31` : null;

  const rows = (await sql`
    SELECT
      sl.code AS afs_line_code,
      sl.label,
      sl.note_number,
      sl.combine_group,
      COALESCE(SUM(
        CASE WHEN gje.entry_date BETWEEN ${start} AND ${end}
             THEN gjl.debit - gjl.credit ELSE 0 END
      ), 0) AS current_amount,
      COALESCE(SUM(
        CASE WHEN ${priorStart}::DATE IS NOT NULL
             AND gje.entry_date BETWEEN ${priorStart} AND ${priorEnd}
             THEN gjl.debit - gjl.credit ELSE 0 END
      ), 0) AS prior_amount
    FROM afs_statement_lines sl
    JOIN afs_account_mappings am ON am.afs_line_code = sl.code AND am.company_id = sl.company_id
    JOIN gl_journal_lines gjl ON gjl.gl_account_id = am.gl_account_id AND gjl.company_id = ${companyId}
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id AND gje.status = 'posted'
    WHERE sl.company_id = ${companyId}
      AND sl.code = ANY(${codes})
      AND sl.is_active = true
    GROUP BY sl.code, sl.label, sl.note_number, sl.combine_group, sl.sort_order
    ORDER BY sl.sort_order
  `) as DbRow[];

  return rows.map((r) => ({
    afsLineCode: String(r.afs_line_code ?? ''),
    label: String(r.label ?? ''),
    noteNumber: r.note_number != null ? Number(r.note_number) : null,
    combineGroup: r.combine_group != null ? String(r.combine_group) : null,
    currentAmount: toNum(r.current_amount),
    priorAmount: toNum(r.prior_amount),
  }));
}

/**
 * Apply combine_group directives: group AfsLineBalance entries that share a combine_group
 * into a single row with summed amounts. Non-grouped rows pass through unchanged.
 */
export function applyCombineGroups(lines: AfsLineBalance[]): AfsLineBalance[] {
  const groups = new Map<string, AfsLineBalance>();
  const result: AfsLineBalance[] = [];

  for (const line of lines) {
    if (!line.combineGroup) {
      result.push(line);
      continue;
    }
    const existing = groups.get(line.combineGroup);
    if (existing) {
      existing.currentAmount += line.currentAmount;
      existing.priorAmount += line.priorAmount;
    } else {
      const combined = { ...line };
      groups.set(line.combineGroup, combined);
      result.push(combined);
    }
  }

  return result;
}

// ── Prior Year GL Helper ─────────────────────────────────────────────────────

/**
 * Fetch a single aggregate balance from GL journal lines for given account subtypes,
 * supporting both current and prior year in one query.
 */
export async function fetchSubtypeBalances(
  companyId: string,
  subtypes: string[],
  fiscalYear: number,
  opts?: { priorYear?: number; creditNormal?: boolean },
): Promise<{ current: number; prior: number }> {
  const { start, end } = fiscalRange(fiscalYear);
  const priorStart = opts?.priorYear ? `${opts.priorYear}-01-01` : null;
  const priorEnd = opts?.priorYear ? `${opts.priorYear}-12-31` : null;
  const sign = opts?.creditNormal ? -1 : 1;

  const rows = (await sql`
    SELECT
      COALESCE(SUM(
        CASE WHEN gje.entry_date BETWEEN ${start} AND ${end}
             THEN (gjl.debit - gjl.credit) * ${sign} ELSE 0 END
      ), 0) AS current_amount,
      COALESCE(SUM(
        CASE WHEN ${priorStart}::DATE IS NOT NULL
             AND gje.entry_date BETWEEN ${priorStart} AND ${priorEnd}
             THEN (gjl.debit - gjl.credit) * ${sign} ELSE 0 END
      ), 0) AS prior_amount
    FROM gl_accounts ga
    JOIN gl_journal_lines gjl ON gjl.gl_account_id = ga.id AND gjl.company_id = ${companyId}
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id AND gje.status = 'posted'
    WHERE ga.company_id = ${companyId}
      AND ga.account_subtype = ANY(${subtypes})
  `) as DbRow[];

  const r = rows[0] ?? {};
  return { current: toNum(r.current_amount), prior: toNum(r.prior_amount) };
}

// ── IFRS Policy Wording ──────────────────────────────────────────────────────

export type FrameworkType = 'ifrs_smes' | 'full_ifrs';

interface PolicyBlock {
  heading: string;
  ifrs_smes: string;
  full_ifrs: string;
}

const POLICY_BLOCKS: PolicyBlock[] = [
  {
    heading: 'Basis of Preparation',
    ifrs_smes:
      'These financial statements have been prepared in accordance with the International Financial ' +
      'Reporting Standard for Small and Medium-sized Entities (IFRS for SMEs) issued by the IASB, ' +
      'and the Companies Act 71 of 2008, as amended.',
    full_ifrs:
      'These financial statements have been prepared in accordance with International Financial ' +
      'Reporting Standards (IFRS) as issued by the International Accounting Standards Board (IASB), ' +
      'and the Companies Act 71 of 2008, as amended.',
  },
  {
    heading: 'Property, Plant and Equipment',
    ifrs_smes:
      'Property, plant and equipment is carried at cost less accumulated depreciation and any ' +
      'accumulated impairment losses. Depreciation is provided on the straight-line method to write ' +
      'down the cost, less estimated residual value, over the estimated useful life of each asset. ' +
      'The useful lives of items of property, plant and equipment have been assessed as follows per ' +
      'the company\'s policy schedule. An item of PPE is derecognised on disposal or when no future ' +
      'economic benefits are expected. The gain or loss on derecognition is included in profit or loss.',
    full_ifrs:
      'Property, plant and equipment is initially recognised at cost (IAS 16). The entity applies the ' +
      'cost model — assets are carried at cost less accumulated depreciation and impairment losses. ' +
      'Depreciation is calculated using the straight-line method over the estimated useful life. ' +
      'Residual values and useful lives are reviewed at each reporting date and adjusted if appropriate. ' +
      'Gains and losses on disposal are determined by comparing proceeds with the carrying amount ' +
      'and are recognised in profit or loss.',
  },
  {
    heading: 'Intangible Assets',
    ifrs_smes:
      'Intangible assets acquired separately are measured on initial recognition at cost. ' +
      'Intangible assets are subsequently carried at cost less any accumulated amortisation and ' +
      'accumulated impairment losses. Amortisation is recognised on a straight-line basis over the ' +
      'estimated useful life. The amortisation period and method are reviewed at each reporting date.',
    full_ifrs:
      'Intangible assets acquired separately are measured at cost on initial recognition (IAS 38). ' +
      'Subsequently, intangible assets with finite useful lives are carried at cost less accumulated ' +
      'amortisation and impairment losses. Intangible assets with indefinite useful lives are not ' +
      'amortised but are tested annually for impairment. Research expenditure is recognised as an ' +
      'expense when incurred. Development costs are capitalised when the criteria in IAS 38 are met.',
  },
  {
    heading: 'Revenue Recognition',
    ifrs_smes:
      'Revenue from the sale of goods is recognised when the significant risks and rewards of ' +
      'ownership have been transferred to the buyer (Section 23 of IFRS for SMEs). Revenue from the ' +
      'rendering of services is recognised by reference to the stage of completion. Interest revenue ' +
      'is recognised using the effective interest method. Dividend revenue is recognised when the ' +
      'right to receive payment is established.',
    full_ifrs:
      'Revenue is recognised in accordance with IFRS 15 — Revenue from Contracts with Customers. ' +
      'Revenue is recognised when (or as) a performance obligation is satisfied by transferring a ' +
      'promised good or service to the customer. Revenue is measured at the transaction price allocated ' +
      'to the performance obligation. The entity applies the five-step model: identify the contract, ' +
      'identify performance obligations, determine the transaction price, allocate to obligations, ' +
      'and recognise when/as each obligation is satisfied.',
  },
  {
    heading: 'Financial Instruments',
    ifrs_smes:
      'Financial instruments are classified as either basic financial instruments (Section 11) or ' +
      'other financial instruments (Section 12). Basic financial instruments include cash, demand and ' +
      'fixed deposits, trade receivables/payables, and simple debt instruments. They are initially ' +
      'measured at the transaction price and subsequently at amortised cost using the effective ' +
      'interest method. Impairment is assessed at each reporting date; losses are recognised in ' +
      'profit or loss.',
    full_ifrs:
      'Financial instruments are classified and measured in accordance with IFRS 9. Financial assets ' +
      'are classified as measured at amortised cost, fair value through other comprehensive income ' +
      '(FVOCI), or fair value through profit or loss (FVTPL). The classification depends on the ' +
      'entity\'s business model and the contractual cash flow characteristics. Impairment is ' +
      'measured using the expected credit loss (ECL) model.',
  },
  {
    heading: 'Leases',
    ifrs_smes:
      'Leases are classified as either finance leases or operating leases. Finance lease assets are ' +
      'recognised at the lower of the fair value and the present value of minimum lease payments. ' +
      'Operating lease payments are recognised as an expense on a straight-line basis over the lease term.',
    full_ifrs:
      'The entity applies IFRS 16 — Leases. At inception, a right-of-use asset and lease liability ' +
      'are recognised for all leases except short-term leases (≤ 12 months) and leases of low-value ' +
      'assets. The right-of-use asset is measured at cost and depreciated over the shorter of the ' +
      'lease term and useful life. The lease liability is measured at the present value of lease payments.',
  },
  {
    heading: 'Inventories',
    ifrs_smes:
      'Inventories are measured at the lower of cost and estimated selling price less costs to ' +
      'complete and sell. Cost is determined using the weighted average cost method. Write-downs to ' +
      'selling price less costs to complete and sell are recognised as an expense.',
    full_ifrs:
      'Inventories are measured at the lower of cost and net realisable value (IAS 2). Cost is ' +
      'determined using the weighted average cost method. Net realisable value is the estimated ' +
      'selling price in the ordinary course of business less estimated costs of completion and ' +
      'estimated costs to make the sale.',
  },
  {
    heading: 'Taxation',
    ifrs_smes:
      'Current tax is measured at the amount expected to be paid to or recovered from the tax ' +
      'authorities using tax rates enacted or substantively enacted at the reporting date. Deferred ' +
      'tax is recognised on temporary differences between the carrying amounts of assets and ' +
      'liabilities and their tax bases, measured at tax rates expected to apply when the temporary ' +
      'differences reverse.',
    full_ifrs:
      'Current tax is recognised in accordance with IAS 12 at the amount expected to be paid to or ' +
      'recovered from the tax authorities using tax rates enacted or substantively enacted at the ' +
      'reporting date. Deferred tax is recognised for all temporary differences between the carrying ' +
      'amount of assets/liabilities and their tax base. Deferred tax assets are recognised only to ' +
      'the extent it is probable that taxable profit will be available against which the deductible ' +
      'temporary difference can be utilised.',
  },
  {
    heading: 'Provisions',
    ifrs_smes:
      'Provisions are recognised when the entity has a present obligation as a result of a past ' +
      'event, it is probable that an outflow of resources embodying economic benefits will be ' +
      'required to settle the obligation, and a reliable estimate can be made of the amount.',
    full_ifrs:
      'Provisions are recognised in accordance with IAS 37 when the entity has a present obligation ' +
      '(legal or constructive) as a result of a past event, it is probable that an outflow will be ' +
      'required, and the amount can be reliably estimated. Provisions are measured at the best ' +
      'estimate of the expenditure required. Where the effect of the time value of money is material, ' +
      'provisions are discounted to present value.',
  },
  {
    heading: 'Employee Benefits',
    ifrs_smes:
      'Short-term employee benefits are recognised as an expense in the period in which the service ' +
      'is received. Contributions to defined contribution plans are recognised as an expense when ' +
      'due. Provisions for annual leave and bonuses are recognised when the entity has a present ' +
      'obligation to make such payments.',
    full_ifrs:
      'Short-term employee benefits are recognised in accordance with IAS 19 as an expense in the ' +
      'period the service is received. The entity participates in defined contribution retirement ' +
      'funds — contributions are expensed as incurred. Leave pay and bonus accruals are measured at ' +
      'undiscounted amounts expected to be paid.',
  },
];

/**
 * Get accounting policy paragraphs for the selected framework.
 * Returns structured blocks suitable for Note 1 content.
 */
export function getAccountingPolicies(
  framework: FrameworkType,
  overrides?: { depMethod?: string; invMethod?: string; currency?: string; vatBasis?: string },
): Array<{ heading: string; text: string }> {
  const policies = POLICY_BLOCKS.map((block) => ({
    heading: block.heading,
    text: block[framework],
  }));

  // Apply company-specific overrides to relevant policies
  if (overrides?.currency) {
    const basisIdx = policies.findIndex((p) => p.heading === 'Basis of Preparation');
    if (basisIdx >= 0) {
      policies[basisIdx]!.text += ` The financial statements are presented in ${overrides.currency} and rounded to the nearest Rand.`;
    }
  }

  if (overrides?.vatBasis) {
    const taxIdx = policies.findIndex((p) => p.heading === 'Taxation');
    if (taxIdx >= 0) {
      policies[taxIdx]!.text += ` The entity accounts for VAT on the ${overrides.vatBasis} basis.`;
    }
  }

  return policies;
}
