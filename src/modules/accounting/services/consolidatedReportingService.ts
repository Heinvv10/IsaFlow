/**
 * Consolidated Reporting Service
 *
 * Generates consolidated financial reports across a group of companies.
 * Combines individual company reports, maps them to the group COA,
 * and applies elimination adjustments.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

// ── Types ────────────────────────────────────────────────────────────────────

interface EntityBalance {
  debit: number;
  credit: number;
}

interface ConsolidatedTrialBalanceRow {
  groupAccountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  entities: Record<string, EntityBalance>;
  eliminationDebit: number;
  eliminationCredit: number;
  consolidatedDebit: number;
  consolidatedCredit: number;
}

interface ConsolidatedTrialBalanceTotals {
  entities: Record<string, EntityBalance>;
  eliminationDebit: number;
  eliminationCredit: number;
  consolidatedDebit: number;
  consolidatedCredit: number;
}

export interface ConsolidatedTrialBalance {
  groupId: string;
  periodStart: string;
  periodEnd: string;
  groupAccounts: ConsolidatedTrialBalanceRow[];
  totals: ConsolidatedTrialBalanceTotals;
}

interface EntityAmount {
  amount: number;
}

interface ConsolidatedLineItem {
  groupAccountId: string;
  accountCode: string;
  accountName: string;
  entities: Record<string, EntityAmount>;
  eliminationAmount: number;
  consolidatedAmount: number;
}

interface ConsolidatedISTotals {
  entities: Record<string, number>;
  eliminationAmount: number;
  consolidatedAmount: number;
}

export interface ConsolidatedIncomeStatement {
  groupId: string;
  periodStart: string;
  periodEnd: string;
  revenue: ConsolidatedLineItem[];
  costOfSales: ConsolidatedLineItem[];
  operatingExpenses: ConsolidatedLineItem[];
  totalRevenue: ConsolidatedISTotals;
  totalCostOfSales: ConsolidatedISTotals;
  grossProfit: ConsolidatedISTotals;
  totalOperatingExpenses: ConsolidatedISTotals;
  netProfit: ConsolidatedISTotals;
}

interface ConsolidatedBSLineItem {
  groupAccountId: string;
  accountCode: string;
  accountName: string;
  entities: Record<string, number>;
  eliminationAmount: number;
  consolidatedAmount: number;
}

interface ConsolidatedBSTotals {
  entities: Record<string, number>;
  eliminationAmount: number;
  consolidatedAmount: number;
}

export interface ConsolidatedBalanceSheet {
  groupId: string;
  asAtDate: string;
  assets: ConsolidatedBSLineItem[];
  liabilities: ConsolidatedBSLineItem[];
  equity: ConsolidatedBSLineItem[];
  totalAssets: ConsolidatedBSTotals;
  totalLiabilities: ConsolidatedBSTotals;
  totalEquity: ConsolidatedBSTotals;
}

interface EntitySummary {
  companyId: string;
  companyName: string;
  revenue: number;
  expenses: number;
  netProfit: number;
  cashPosition: number;
}

export interface GroupDashboardStats {
  groupId: string;
  combinedCashPosition: number;
  combinedARTotal: number;
  combinedAPTotal: number;
  combinedRevenue: number;
  combinedExpenses: number;
  entitySummaries: EntitySummary[];
}

interface EliminationLine {
  groupAccountId: string;
  debit: number;
  credit: number;
  description: string;
}

export interface ConsolidationAdjustment {
  id: string;
  groupId: string;
  adjustmentNumber: string;
  adjustmentType: string;
  description: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  lines: EliminationLine[];
  sourceIntercompanyId: string | null;
  postedBy: string | null;
  postedAt: string | null;
  createdAt: string;
}

interface CreateEliminationInput {
  adjustmentType: string;
  description: string;
  periodStart: string;
  periodEnd: string;
  lines: EliminationLine[];
  sourceIntercompanyId?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface GroupMember {
  companyId: string;
  companyName: string;
  ownershipPct: number;
  consolidationMethod: string;
}

async function getGroupMembers(groupId: string): Promise<GroupMember[]> {
  const rows = (await sql`
    SELECT cgm.company_id, c.name AS company_name,
           cgm.ownership_pct, cgm.consolidation_method
    FROM company_group_members cgm
    JOIN companies c ON c.id = cgm.company_id
    WHERE cgm.group_id = ${groupId}::UUID
      AND cgm.left_date IS NULL
    ORDER BY cgm.is_holding DESC, c.name
  `) as Row[];

  return rows.map((r: Row) => ({
    companyId: String(r.company_id),
    companyName: String(r.company_name),
    ownershipPct: Number(r.ownership_pct),
    consolidationMethod: String(r.consolidation_method),
  }));
}

interface MappingEntry {
  groupAccountId: string;
  groupAccountCode: string;
  groupAccountName: string;
  groupAccountType: string;
  groupNormalBalance: string;
  companyAccountId: string;
}

async function getCoaMappings(
  groupId: string,
  companyId: string
): Promise<Map<string, MappingEntry>> {
  const rows = (await sql`
    SELECT gcm.company_account_id,
           gcm.group_account_id,
           ga.account_code AS group_account_code,
           ga.account_name AS group_account_name,
           ga.account_type AS group_account_type,
           ga.normal_balance AS group_normal_balance
    FROM group_coa_mappings gcm
    JOIN group_accounts ga ON ga.id = gcm.group_account_id
    WHERE gcm.group_id = ${groupId}::UUID
      AND gcm.company_id = ${companyId}::UUID
  `) as Row[];

  const map = new Map<string, MappingEntry>();
  for (const r of rows) {
    map.set(String(r.company_account_id), {
      groupAccountId: String(r.group_account_id),
      groupAccountCode: String(r.group_account_code),
      groupAccountName: String(r.group_account_name),
      groupAccountType: String(r.group_account_type),
      groupNormalBalance: String(r.group_normal_balance),
      companyAccountId: String(r.company_account_id),
    });
  }
  return map;
}

interface EliminationLineWithAccount {
  groupAccountId: string;
  groupAccountCode: string;
  groupAccountName: string;
  debit: number;
  credit: number;
}

async function getPostedEliminations(
  groupId: string,
  periodStart: string,
  periodEnd: string
): Promise<EliminationLineWithAccount[]> {
  const _rows = (await sql`
    SELECT ca.lines, ga.id AS group_account_id,
           ga.account_code AS group_account_code,
           ga.account_name AS group_account_name
    FROM consolidation_adjustments ca
    CROSS JOIN LATERAL jsonb_array_elements(ca.lines) AS line_elem
    JOIN group_accounts ga ON ga.id = (line_elem->>'groupAccountId')::UUID
    WHERE ca.group_id = ${groupId}::UUID
      AND ca.status = 'posted'
      AND ca.period_start >= ${periodStart}
      AND ca.period_end <= ${periodEnd}
  `) as Row[];

  // Re-query to get the raw adjustments and parse lines manually
  const adjRows = (await sql`
    SELECT ca.lines
    FROM consolidation_adjustments ca
    WHERE ca.group_id = ${groupId}::UUID
      AND ca.status = 'posted'
      AND ca.period_start >= ${periodStart}
      AND ca.period_end <= ${periodEnd}
  `) as Row[];

  const allLines: EliminationLineWithAccount[] = [];

  for (const adj of adjRows) {
    const lines = typeof adj.lines === 'string' ? JSON.parse(adj.lines) : adj.lines;
    for (const line of lines) {
      // Look up group account details
      const gaRows = (await sql`
        SELECT id, account_code, account_name
        FROM group_accounts
        WHERE id = ${line.groupAccountId}::UUID
      `) as Row[];

      if (gaRows.length > 0) {
        allLines.push({
          groupAccountId: String(gaRows[0].id),
          groupAccountCode: String(gaRows[0].account_code),
          groupAccountName: String(gaRows[0].account_name),
          debit: Number(line.debit || 0),
          credit: Number(line.credit || 0),
        });
      }
    }
  }

  return allLines;
}

// ── 1. Consolidated Trial Balance ────────────────────────────────────────────

export async function getConsolidatedTrialBalance(
  groupId: string,
  periodStart: string,
  periodEnd: string
): Promise<ConsolidatedTrialBalance> {
  try {
    const members = await getGroupMembers(groupId);

    // Accumulator: groupAccountId -> row data
    const accountMap = new Map<string, ConsolidatedTrialBalanceRow>();

    for (const member of members) {
      const mappings = await getCoaMappings(groupId, member.companyId);

      // Fetch GL data for this company for the period
      const rows = (await sql`
        SELECT ga.id AS account_id,
               COALESCE(SUM(jl.debit), 0) AS total_debit,
               COALESCE(SUM(jl.credit), 0) AS total_credit
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE je.status = 'posted'
          AND je.company_id = ${member.companyId}::UUID
          AND ga.company_id = ${member.companyId}::UUID
          AND je.entry_date >= ${periodStart}
          AND je.entry_date <= ${periodEnd}
        GROUP BY ga.id
        HAVING COALESCE(SUM(jl.debit), 0) != 0
            OR COALESCE(SUM(jl.credit), 0) != 0
      `) as Row[];

      for (const r of rows) {
        const accountId = String(r.account_id);
        const mapping = mappings.get(accountId);
        if (!mapping) continue; // unmapped account — skip

        const debit = Number(r.total_debit);
        const credit = Number(r.total_credit);

        let entry = accountMap.get(mapping.groupAccountId);
        if (!entry) {
          entry = {
            groupAccountId: mapping.groupAccountId,
            accountCode: mapping.groupAccountCode,
            accountName: mapping.groupAccountName,
            accountType: mapping.groupAccountType,
            entities: {},
            eliminationDebit: 0,
            eliminationCredit: 0,
            consolidatedDebit: 0,
            consolidatedCredit: 0,
          };
          accountMap.set(mapping.groupAccountId, entry);
        }

        if (!entry.entities[member.companyId]) {
          entry.entities[member.companyId] = { debit: 0, credit: 0 };
        }
        entry.entities[member.companyId]!.debit += debit;
        entry.entities[member.companyId]!.credit += credit;
      }
    }

    // Apply elimination adjustments
    const eliminations = await getPostedEliminations(groupId, periodStart, periodEnd);
    for (const elim of eliminations) {
      let entry = accountMap.get(elim.groupAccountId);
      if (!entry) {
        entry = {
          groupAccountId: elim.groupAccountId,
          accountCode: elim.groupAccountCode,
          accountName: elim.groupAccountName,
          accountType: '',
          entities: {},
          eliminationDebit: 0,
          eliminationCredit: 0,
          consolidatedDebit: 0,
          consolidatedCredit: 0,
        };
        accountMap.set(elim.groupAccountId, entry);
      }
      entry.eliminationDebit += elim.debit;
      entry.eliminationCredit += elim.credit;
    }

    // Calculate consolidated totals per account
    const groupAccounts: ConsolidatedTrialBalanceRow[] = [];
    const totals: ConsolidatedTrialBalanceTotals = {
      entities: {},
      eliminationDebit: 0,
      eliminationCredit: 0,
      consolidatedDebit: 0,
      consolidatedCredit: 0,
    };

    for (const entry of accountMap.values()) {
      let entityDebitSum = 0;
      let entityCreditSum = 0;

      for (const [companyId, bal] of Object.entries(entry.entities)) {
        entityDebitSum += bal.debit;
        entityCreditSum += bal.credit;

        if (!totals.entities[companyId]) {
          totals.entities[companyId] = { debit: 0, credit: 0 };
        }
        totals.entities[companyId].debit += bal.debit;
        totals.entities[companyId].credit += bal.credit;
      }

      entry.consolidatedDebit = entityDebitSum + entry.eliminationDebit;
      entry.consolidatedCredit = entityCreditSum + entry.eliminationCredit;

      totals.eliminationDebit += entry.eliminationDebit;
      totals.eliminationCredit += entry.eliminationCredit;
      totals.consolidatedDebit += entry.consolidatedDebit;
      totals.consolidatedCredit += entry.consolidatedCredit;

      groupAccounts.push(entry);
    }

    groupAccounts.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

    return { groupId, periodStart, periodEnd, groupAccounts, totals };
  } catch (err) {
    log.error('Failed to generate consolidated trial balance', { groupId, error: err }, 'accounting');
    throw err;
  }
}

// ── 2. Consolidated Income Statement ─────────────────────────────────────────

export async function getConsolidatedIncomeStatement(
  groupId: string,
  periodStart: string,
  periodEnd: string
): Promise<ConsolidatedIncomeStatement> {
  try {
    const members = await getGroupMembers(groupId);

    // groupAccountId -> { ...lineItem, category }
    const lineMap = new Map<string, ConsolidatedLineItem & { category: string }>();

    for (const member of members) {
      const mappings = await getCoaMappings(groupId, member.companyId);

      const rows = (await sql`
        SELECT ga.id AS account_id, ga.account_type, ga.account_subtype,
               COALESCE(SUM(jl.debit), 0) AS total_debit,
               COALESCE(SUM(jl.credit), 0) AS total_credit
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE je.status = 'posted'
          AND je.company_id = ${member.companyId}::UUID
          AND ga.company_id = ${member.companyId}::UUID
          AND je.entry_date >= ${periodStart}
          AND je.entry_date <= ${periodEnd}
          AND ga.account_type IN ('revenue', 'expense')
        GROUP BY ga.id, ga.account_type, ga.account_subtype
      `) as Row[];

      for (const r of rows) {
        const accountId = String(r.account_id);
        const mapping = mappings.get(accountId);
        if (!mapping) continue;

        const type = String(r.account_type);
        const subtype = r.account_subtype ? String(r.account_subtype) : '';
        const debit = Number(r.total_debit);
        const credit = Number(r.total_credit);

        let amount: number;
        let category: string;

        if (type === 'revenue') {
          amount = credit - debit;
          category = 'revenue';
        } else {
          amount = debit - credit;
          category = subtype === 'cost_of_sales' ? 'costOfSales' : 'operatingExpenses';
        }

        if (Math.abs(amount) < 0.001) continue;

        let entry = lineMap.get(mapping.groupAccountId);
        if (!entry) {
          entry = {
            groupAccountId: mapping.groupAccountId,
            accountCode: mapping.groupAccountCode,
            accountName: mapping.groupAccountName,
            entities: {},
            eliminationAmount: 0,
            consolidatedAmount: 0,
            category,
          };
          lineMap.set(mapping.groupAccountId, entry);
        }

        if (!entry.entities[member.companyId]) {
          entry.entities[member.companyId] = { amount: 0 };
        }
        entry.entities[member.companyId]!.amount += amount;
      }
    }

    // Apply elimination adjustments for revenue/expense group accounts
    const eliminations = await getPostedEliminations(groupId, periodStart, periodEnd);
    for (const elim of eliminations) {
      const entry = lineMap.get(elim.groupAccountId);
      if (!entry) continue;
      // Eliminations reduce amounts: net of debit/credit
      entry.eliminationAmount += elim.credit - elim.debit;
    }

    // Categorise and compute consolidated amounts
    const revenue: ConsolidatedLineItem[] = [];
    const costOfSales: ConsolidatedLineItem[] = [];
    const operatingExpenses: ConsolidatedLineItem[] = [];

    for (const entry of lineMap.values()) {
      let entitySum = 0;
      for (const e of Object.values(entry.entities)) {
        entitySum += e.amount;
      }
      entry.consolidatedAmount = entitySum + entry.eliminationAmount;

      const { category, ...lineItem } = entry;
      if (category === 'revenue') revenue.push(lineItem);
      else if (category === 'costOfSales') costOfSales.push(lineItem);
      else operatingExpenses.push(lineItem);
    }

    revenue.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    costOfSales.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    operatingExpenses.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

    // Build totals
    const buildTotals = (items: ConsolidatedLineItem[]): ConsolidatedISTotals => {
      const t: ConsolidatedISTotals = { entities: {}, eliminationAmount: 0, consolidatedAmount: 0 };
      for (const item of items) {
        for (const [cid, e] of Object.entries(item.entities)) {
          t.entities[cid] = (t.entities[cid] || 0) + e.amount;
        }
        t.eliminationAmount += item.eliminationAmount;
        t.consolidatedAmount += item.consolidatedAmount;
      }
      return t;
    };

    const totalRevenue = buildTotals(revenue);
    const totalCostOfSales = buildTotals(costOfSales);
    const totalOperatingExpenses = buildTotals(operatingExpenses);

    // Gross profit = revenue - cost of sales
    const grossProfit: ConsolidatedISTotals = { entities: {}, eliminationAmount: 0, consolidatedAmount: 0 };
    const allCompanyIds = new Set([
      ...Object.keys(totalRevenue.entities),
      ...Object.keys(totalCostOfSales.entities),
    ]);
    for (const cid of allCompanyIds) {
      grossProfit.entities[cid] = (totalRevenue.entities[cid] || 0) - (totalCostOfSales.entities[cid] || 0);
    }
    grossProfit.eliminationAmount = totalRevenue.eliminationAmount - totalCostOfSales.eliminationAmount;
    grossProfit.consolidatedAmount = totalRevenue.consolidatedAmount - totalCostOfSales.consolidatedAmount;

    // Net profit = gross profit - operating expenses
    const netProfit: ConsolidatedISTotals = { entities: {}, eliminationAmount: 0, consolidatedAmount: 0 };
    const allCids = new Set([
      ...Object.keys(grossProfit.entities),
      ...Object.keys(totalOperatingExpenses.entities),
    ]);
    for (const cid of allCids) {
      netProfit.entities[cid] = (grossProfit.entities[cid] || 0) - (totalOperatingExpenses.entities[cid] || 0);
    }
    netProfit.eliminationAmount = grossProfit.eliminationAmount - totalOperatingExpenses.eliminationAmount;
    netProfit.consolidatedAmount = grossProfit.consolidatedAmount - totalOperatingExpenses.consolidatedAmount;

    return {
      groupId,
      periodStart,
      periodEnd,
      revenue,
      costOfSales,
      operatingExpenses,
      totalRevenue,
      totalCostOfSales,
      grossProfit,
      totalOperatingExpenses,
      netProfit,
    };
  } catch (err) {
    log.error('Failed to generate consolidated income statement', { groupId, error: err }, 'accounting');
    throw err;
  }
}

// ── 3. Consolidated Balance Sheet ────────────────────────────────────────────

export async function getConsolidatedBalanceSheet(
  groupId: string,
  asAtDate: string
): Promise<ConsolidatedBalanceSheet> {
  try {
    const members = await getGroupMembers(groupId);

    // groupAccountId -> line item with category
    const lineMap = new Map<string, ConsolidatedBSLineItem & { category: string; normalBalance: string }>();

    for (const member of members) {
      const mappings = await getCoaMappings(groupId, member.companyId);

      const rows = (await sql`
        SELECT ga.id AS account_id, ga.account_type, ga.normal_balance,
               COALESCE(SUM(jl.debit), 0) AS total_debit,
               COALESCE(SUM(jl.credit), 0) AS total_credit
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE je.status = 'posted'
          AND je.company_id = ${member.companyId}::UUID
          AND ga.company_id = ${member.companyId}::UUID
          AND je.entry_date <= ${asAtDate}
          AND ga.account_type IN ('asset', 'liability', 'equity')
        GROUP BY ga.id, ga.account_type, ga.normal_balance
      `) as Row[];

      for (const r of rows) {
        const accountId = String(r.account_id);
        const mapping = mappings.get(accountId);
        if (!mapping) continue;

        const normalBal = String(r.normal_balance);
        const debit = Number(r.total_debit);
        const credit = Number(r.total_credit);
        const balance = normalBal === 'debit' ? debit - credit : credit - debit;

        if (Math.abs(balance) < 0.01) continue;

        let entry = lineMap.get(mapping.groupAccountId);
        if (!entry) {
          entry = {
            groupAccountId: mapping.groupAccountId,
            accountCode: mapping.groupAccountCode,
            accountName: mapping.groupAccountName,
            entities: {},
            eliminationAmount: 0,
            consolidatedAmount: 0,
            category: mapping.groupAccountType,
            normalBalance: mapping.groupNormalBalance,
          };
          lineMap.set(mapping.groupAccountId, entry);
        }

        entry.entities[member.companyId] = (entry.entities[member.companyId] || 0) + balance;
      }

      // Add retained earnings for this company
      const reRows = (await sql`
        SELECT
          COALESCE(SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit ELSE 0 END), 0) AS revenue,
          COALESCE(SUM(CASE WHEN ga.account_type = 'expense' THEN jl.debit - jl.credit ELSE 0 END), 0) AS expenses
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE je.status = 'posted'
          AND je.company_id = ${member.companyId}::UUID
          AND ga.company_id = ${member.companyId}::UUID
          AND je.entry_date <= ${asAtDate}
          AND ga.account_type IN ('revenue', 'expense')
      `) as Row[];

      const retainedEarnings = Number(reRows[0]?.revenue ?? 0) - Number(reRows[0]?.expenses ?? 0);
      if (Math.abs(retainedEarnings) > 0.01) {
        // Find the group account mapped to retained earnings (look for equity type)
        const reMapping = (await sql`
          SELECT gcm.group_account_id, ga.account_code, ga.account_name, ga.normal_balance
          FROM group_coa_mappings gcm
          JOIN group_accounts ga ON ga.id = gcm.group_account_id
          WHERE gcm.group_id = ${groupId}::UUID
            AND gcm.company_id = ${member.companyId}::UUID
            AND ga.account_type = 'equity'
            AND ga.account_subtype = 'retained_earnings'
          LIMIT 1
        `) as Row[];

        if (reMapping.length > 0) {
          const gaId = String(reMapping[0].group_account_id);
          let entry = lineMap.get(gaId);
          if (!entry) {
            entry = {
              groupAccountId: gaId,
              accountCode: String(reMapping[0].account_code),
              accountName: String(reMapping[0].account_name),
              entities: {},
              eliminationAmount: 0,
              consolidatedAmount: 0,
              category: 'equity',
              normalBalance: String(reMapping[0].normal_balance),
            };
            lineMap.set(gaId, entry);
          }
          entry.entities[member.companyId] = (entry.entities[member.companyId] || 0) + retainedEarnings;
        }
      }
    }

    // Apply eliminations (use a wide date range up to asAtDate for balance sheet)
    const eliminations = await getPostedEliminations(groupId, '1900-01-01', asAtDate);
    for (const elim of eliminations) {
      const entry = lineMap.get(elim.groupAccountId);
      if (!entry) continue;
      const normalBal = entry.normalBalance;
      entry.eliminationAmount += normalBal === 'debit'
        ? elim.debit - elim.credit
        : elim.credit - elim.debit;
    }

    // Categorise
    const assets: ConsolidatedBSLineItem[] = [];
    const liabilities: ConsolidatedBSLineItem[] = [];
    const equity: ConsolidatedBSLineItem[] = [];

    for (const raw of lineMap.values()) {
      let entitySum = 0;
      for (const v of Object.values(raw.entities)) {
        entitySum += v;
      }
      raw.consolidatedAmount = entitySum + raw.eliminationAmount;

      const { category, normalBalance: _nb, ...lineItem } = raw;
      if (category === 'asset') assets.push(lineItem);
      else if (category === 'liability') liabilities.push(lineItem);
      else if (category === 'equity') equity.push(lineItem);
    }

    assets.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    liabilities.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    equity.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

    const buildBSTotals = (items: ConsolidatedBSLineItem[]): ConsolidatedBSTotals => {
      const t: ConsolidatedBSTotals = { entities: {}, eliminationAmount: 0, consolidatedAmount: 0 };
      for (const item of items) {
        for (const [cid, val] of Object.entries(item.entities)) {
          t.entities[cid] = (t.entities[cid] || 0) + val;
        }
        t.eliminationAmount += item.eliminationAmount;
        t.consolidatedAmount += item.consolidatedAmount;
      }
      return t;
    };

    return {
      groupId,
      asAtDate,
      assets,
      liabilities,
      equity,
      totalAssets: buildBSTotals(assets),
      totalLiabilities: buildBSTotals(liabilities),
      totalEquity: buildBSTotals(equity),
    };
  } catch (err) {
    log.error('Failed to generate consolidated balance sheet', { groupId, error: err }, 'accounting');
    throw err;
  }
}

// ── 4. Group Dashboard Stats ─────────────────────────────────────────────────

export async function getGroupDashboardStats(
  groupId: string
): Promise<GroupDashboardStats> {
  try {
    const members = await getGroupMembers(groupId);

    let combinedCashPosition = 0;
    let combinedARTotal = 0;
    let combinedAPTotal = 0;
    let combinedRevenue = 0;
    let combinedExpenses = 0;
    const entitySummaries: EntitySummary[] = [];

    for (const member of members) {
      // Cash position: sum of bank account balances
      const cashRows = (await sql`
        SELECT COALESCE(SUM(ba.current_balance), 0) AS cash
        FROM bank_accounts ba
        WHERE ba.company_id = ${member.companyId}::UUID
          AND ba.is_active = true
      `) as Row[];
      const cash = Number(cashRows[0]?.cash ?? 0);

      // AR total: outstanding customer invoices
      const arRows = (await sql`
        SELECT COALESCE(SUM(ci.balance_due), 0) AS ar
        FROM customer_invoices ci
        WHERE ci.company_id = ${member.companyId}::UUID
          AND ci.status IN ('sent', 'overdue', 'partial')
      `) as Row[];
      const ar = Number(arRows[0]?.ar ?? 0);

      // AP total: outstanding supplier invoices
      const apRows = (await sql`
        SELECT COALESCE(SUM(si.balance_due), 0) AS ap
        FROM supplier_invoices si
        WHERE si.company_id = ${member.companyId}::UUID
          AND si.status IN ('approved', 'overdue', 'partial')
      `) as Row[];
      const ap = Number(apRows[0]?.ap ?? 0);

      // Revenue and expenses for current fiscal year (approximate: calendar year)
      const currentYear = new Date().getFullYear();
      const yearStart = `${currentYear}-01-01`;
      const yearEnd = `${currentYear}-12-31`;

      const plRows = (await sql`
        SELECT ga.account_type,
               COALESCE(SUM(jl.debit), 0) AS total_debit,
               COALESCE(SUM(jl.credit), 0) AS total_credit
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE je.status = 'posted'
          AND je.company_id = ${member.companyId}::UUID
          AND ga.company_id = ${member.companyId}::UUID
          AND je.entry_date >= ${yearStart}
          AND je.entry_date <= ${yearEnd}
          AND ga.account_type IN ('revenue', 'expense')
        GROUP BY ga.account_type
      `) as Row[];

      let entityRevenue = 0;
      let entityExpenses = 0;
      for (const r of plRows) {
        if (String(r.account_type) === 'revenue') {
          entityRevenue = Number(r.total_credit) - Number(r.total_debit);
        } else {
          entityExpenses = Number(r.total_debit) - Number(r.total_credit);
        }
      }

      combinedCashPosition += cash;
      combinedARTotal += ar;
      combinedAPTotal += ap;
      combinedRevenue += entityRevenue;
      combinedExpenses += entityExpenses;

      entitySummaries.push({
        companyId: member.companyId,
        companyName: member.companyName,
        revenue: entityRevenue,
        expenses: entityExpenses,
        netProfit: entityRevenue - entityExpenses,
        cashPosition: cash,
      });
    }

    return {
      groupId,
      combinedCashPosition,
      combinedARTotal,
      combinedAPTotal,
      combinedRevenue,
      combinedExpenses,
      entitySummaries,
    };
  } catch (err) {
    log.error('Failed to generate group dashboard stats', { groupId, error: err }, 'accounting');
    throw err;
  }
}

// ── 5. Elimination Journal Management ────────────────────────────────────────

function mapAdjustmentRow(r: Row): ConsolidationAdjustment {
  const rawLines = typeof r.lines === 'string' ? JSON.parse(r.lines) : r.lines;
  return {
    id: String(r.id),
    groupId: String(r.group_id),
    adjustmentNumber: String(r.adjustment_number ?? ''),
    adjustmentType: String(r.adjustment_type),
    description: r.description ? String(r.description) : '',
    periodStart: String(r.period_start ?? ''),
    periodEnd: String(r.period_end ?? ''),
    status: String(r.status),
    lines: Array.isArray(rawLines) ? rawLines : [],
    sourceIntercompanyId: r.source_intercompany_id ? String(r.source_intercompany_id) : null,
    postedBy: r.posted_by ? String(r.posted_by) : null,
    postedAt: r.posted_at ? String(r.posted_at) : null,
    createdAt: String(r.created_at),
  };
}

export async function createEliminationAdjustment(
  groupId: string,
  input: CreateEliminationInput
): Promise<ConsolidationAdjustment> {
  try {
    // Validate lines balance
    let totalDebit = 0;
    let totalCredit = 0;
    for (const line of input.lines) {
      totalDebit += line.debit;
      totalCredit += line.credit;
    }
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      throw new Error(`Elimination adjustment lines do not balance: debit=${totalDebit}, credit=${totalCredit}`);
    }

    const rows = (await sql`
      INSERT INTO consolidation_adjustments (
        group_id, adjustment_type, description,
        period_start, period_end, lines,
        source_intercompany_id
      ) VALUES (
        ${groupId}::UUID,
        ${input.adjustmentType},
        ${input.description},
        ${input.periodStart},
        ${input.periodEnd},
        ${JSON.stringify(input.lines)}::JSONB,
        ${input.sourceIntercompanyId ?? null}::UUID
      )
      RETURNING *
    `) as Row[];

    log.info('Created elimination adjustment', { groupId, id: rows[0].id }, 'accounting');
    return mapAdjustmentRow(rows[0]);
  } catch (err) {
    log.error('Failed to create elimination adjustment', { groupId, error: err }, 'accounting');
    throw err;
  }
}

export async function postEliminationAdjustment(
  adjustmentId: string
): Promise<void> {
  try {
    const result = (await sql`
      UPDATE consolidation_adjustments
      SET status = 'posted', posted_at = NOW(), updated_at = NOW()
      WHERE id = ${adjustmentId}::UUID
        AND status = 'draft'
      RETURNING id
    `) as Row[];

    if (result.length === 0) {
      throw new Error(`Adjustment ${adjustmentId} not found or not in draft status`);
    }

    log.info('Posted elimination adjustment', { adjustmentId }, 'accounting');
  } catch (err) {
    log.error('Failed to post elimination adjustment', { adjustmentId, error: err }, 'accounting');
    throw err;
  }
}

export async function reverseEliminationAdjustment(
  adjustmentId: string
): Promise<void> {
  try {
    const result = (await sql`
      UPDATE consolidation_adjustments
      SET status = 'reversed', updated_at = NOW()
      WHERE id = ${adjustmentId}::UUID
        AND status = 'posted'
      RETURNING id
    `) as Row[];

    if (result.length === 0) {
      throw new Error(`Adjustment ${adjustmentId} not found or not in posted status`);
    }

    log.info('Reversed elimination adjustment', { adjustmentId }, 'accounting');
  } catch (err) {
    log.error('Failed to reverse elimination adjustment', { adjustmentId, error: err }, 'accounting');
    throw err;
  }
}

export async function getEliminationAdjustments(
  groupId: string,
  periodStart?: string,
  periodEnd?: string
): Promise<ConsolidationAdjustment[]> {
  try {
    const pStart = periodStart ?? null;
    const pEnd = periodEnd ?? null;

    const rows = (await sql`
      SELECT *
      FROM consolidation_adjustments
      WHERE group_id = ${groupId}::UUID
        AND (${pStart}::DATE IS NULL OR period_start >= ${pStart}::DATE)
        AND (${pEnd}::DATE IS NULL OR period_end <= ${pEnd}::DATE)
      ORDER BY created_at DESC
    `) as Row[];

    return rows.map(mapAdjustmentRow);
  } catch (err) {
    log.error('Failed to fetch elimination adjustments', { groupId, error: err }, 'accounting');
    throw err;
  }
}

export async function autoGenerateEliminations(
  groupId: string,
  periodStart: string,
  periodEnd: string
): Promise<ConsolidationAdjustment[]> {
  try {
    // Find matched intercompany transactions for the period
    const icTxRows = (await sql`
      SELECT ict.id, ict.source_company_id, ict.target_company_id,
             ict.transaction_type, ict.amount, ict.description,
             ict.source_journal_entry_id, ict.target_journal_entry_id
      FROM intercompany_transactions ict
      WHERE ict.group_id = ${groupId}::UUID
        AND ict.match_status = 'matched'
        AND ict.transaction_date >= ${periodStart}
        AND ict.transaction_date <= ${periodEnd}
    `) as Row[];

    const created: ConsolidationAdjustment[] = [];

    for (const tx of icTxRows) {
      const txType = String(tx.transaction_type);
      const amount = Number(tx.amount);
      const sourceCompanyId = String(tx.source_company_id);
      const targetCompanyId = String(tx.target_company_id);

      if (txType === 'sale' || txType === 'purchase' || txType === 'mgmt_fee') {
        // Eliminate intercompany revenue/expense
        // Find the group revenue account (source company's revenue mapped to group)
        const revenueMapping = (await sql`
          SELECT gcm.group_account_id
          FROM group_coa_mappings gcm
          JOIN gl_accounts ga ON ga.id = gcm.company_account_id
          WHERE gcm.group_id = ${groupId}::UUID
            AND gcm.company_id = ${sourceCompanyId}::UUID
            AND ga.company_id = ${sourceCompanyId}::UUID
            AND ga.account_type = 'revenue'
          LIMIT 1
        `) as Row[];

        const expenseMapping = (await sql`
          SELECT gcm.group_account_id
          FROM group_coa_mappings gcm
          JOIN gl_accounts ga ON ga.id = gcm.company_account_id
          WHERE gcm.group_id = ${groupId}::UUID
            AND gcm.company_id = ${targetCompanyId}::UUID
            AND ga.company_id = ${targetCompanyId}::UUID
            AND ga.account_type = 'expense'
          LIMIT 1
        `) as Row[];

        if (revenueMapping.length > 0 && expenseMapping.length > 0) {
          const lines: EliminationLine[] = [
            {
              groupAccountId: String(revenueMapping[0].group_account_id),
              debit: amount,
              credit: 0,
              description: `Eliminate intercompany ${txType} revenue`,
            },
            {
              groupAccountId: String(expenseMapping[0].group_account_id),
              debit: 0,
              credit: amount,
              description: `Eliminate intercompany ${txType} expense`,
            },
          ];

          const adj = await createEliminationAdjustment(groupId, {
            adjustmentType: 'interco_revenue',
            description: `Auto-elimination: intercompany ${txType} - ${tx.description ?? ''}`.trim(),
            periodStart,
            periodEnd,
            lines,
            sourceIntercompanyId: String(tx.id),
          });
          created.push(adj);
        }
      } else if (txType === 'loan' || txType === 'transfer') {
        // Eliminate intercompany balances (receivable vs payable)
        const receivableMapping = (await sql`
          SELECT gcm.group_account_id
          FROM group_coa_mappings gcm
          JOIN gl_accounts ga ON ga.id = gcm.company_account_id
          WHERE gcm.group_id = ${groupId}::UUID
            AND gcm.company_id = ${sourceCompanyId}::UUID
            AND ga.company_id = ${sourceCompanyId}::UUID
            AND ga.account_subtype = 'receivable'
          LIMIT 1
        `) as Row[];

        const payableMapping = (await sql`
          SELECT gcm.group_account_id
          FROM group_coa_mappings gcm
          JOIN gl_accounts ga ON ga.id = gcm.company_account_id
          WHERE gcm.group_id = ${groupId}::UUID
            AND gcm.company_id = ${targetCompanyId}::UUID
            AND ga.company_id = ${targetCompanyId}::UUID
            AND ga.account_subtype = 'payable'
          LIMIT 1
        `) as Row[];

        if (receivableMapping.length > 0 && payableMapping.length > 0) {
          const lines: EliminationLine[] = [
            {
              groupAccountId: String(payableMapping[0].group_account_id),
              debit: amount,
              credit: 0,
              description: `Eliminate intercompany payable`,
            },
            {
              groupAccountId: String(receivableMapping[0].group_account_id),
              debit: 0,
              credit: amount,
              description: `Eliminate intercompany receivable`,
            },
          ];

          const adj = await createEliminationAdjustment(groupId, {
            adjustmentType: 'interco_balance',
            description: `Auto-elimination: intercompany ${txType} balance - ${tx.description ?? ''}`.trim(),
            periodStart,
            periodEnd,
            lines,
            sourceIntercompanyId: String(tx.id),
          });
          created.push(adj);
        }
      }
    }

    log.info('Auto-generated elimination adjustments', { groupId, count: created.length }, 'accounting');
    return created;
  } catch (err) {
    log.error('Failed to auto-generate eliminations', { groupId, error: err }, 'accounting');
    throw err;
  }
}
