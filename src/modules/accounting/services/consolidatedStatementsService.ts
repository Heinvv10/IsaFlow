/**
 * Consolidated Statements Service
 *
 * Income statement and balance sheet generators across a group of companies.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  getGroupMembers,
  getCoaMappings,
  getPostedEliminations,
  type ConsolidatedLineItem,
  type ConsolidatedISTotals,
  type ConsolidatedBSLineItem,
  type ConsolidatedBSTotals,
} from './consolidatedTrialBalanceService';

type Row = Record<string, unknown>;

export interface ConsolidatedIncomeStatement {
  groupId: string; periodStart: string; periodEnd: string;
  revenue: ConsolidatedLineItem[]; costOfSales: ConsolidatedLineItem[];
  operatingExpenses: ConsolidatedLineItem[];
  totalRevenue: ConsolidatedISTotals; totalCostOfSales: ConsolidatedISTotals;
  grossProfit: ConsolidatedISTotals; totalOperatingExpenses: ConsolidatedISTotals;
  netProfit: ConsolidatedISTotals;
}

export interface ConsolidatedBalanceSheet {
  groupId: string; asAtDate: string;
  assets: ConsolidatedBSLineItem[]; liabilities: ConsolidatedBSLineItem[];
  equity: ConsolidatedBSLineItem[];
  totalAssets: ConsolidatedBSTotals; totalLiabilities: ConsolidatedBSTotals;
  totalEquity: ConsolidatedBSTotals;
}

function buildISTotals(items: ConsolidatedLineItem[]): ConsolidatedISTotals {
  const t: ConsolidatedISTotals = { entities: {}, eliminationAmount: 0, consolidatedAmount: 0 };
  for (const item of items) {
    for (const [cid, e] of Object.entries(item.entities)) {
      t.entities[cid] = (t.entities[cid] || 0) + e.amount;
    }
    t.eliminationAmount += item.eliminationAmount;
    t.consolidatedAmount += item.consolidatedAmount;
  }
  return t;
}

function buildBSTotals(items: ConsolidatedBSLineItem[]): ConsolidatedBSTotals {
  const t: ConsolidatedBSTotals = { entities: {}, eliminationAmount: 0, consolidatedAmount: 0 };
  for (const item of items) {
    for (const [cid, val] of Object.entries(item.entities)) {
      t.entities[cid] = (t.entities[cid] || 0) + val;
    }
    t.eliminationAmount += item.eliminationAmount;
    t.consolidatedAmount += item.consolidatedAmount;
  }
  return t;
}

export async function getConsolidatedIncomeStatement(
  groupId: string, periodStart: string, periodEnd: string
): Promise<ConsolidatedIncomeStatement> {
  try {
    const members = await getGroupMembers(groupId);
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
          AND je.entry_date >= ${periodStart} AND je.entry_date <= ${periodEnd}
          AND ga.account_type IN ('revenue', 'expense')
        GROUP BY ga.id, ga.account_type, ga.account_subtype
      `) as Row[];

      for (const r of rows) {
        const mapping = mappings.get(String(r.account_id));
        if (!mapping) continue;
        const type = String(r.account_type);
        const subtype = r.account_subtype ? String(r.account_subtype) : '';
        const debit = Number(r.total_debit); const credit = Number(r.total_credit);
        const amount = type === 'revenue' ? credit - debit : debit - credit;
        const category = type === 'revenue' ? 'revenue' : subtype === 'cost_of_sales' ? 'costOfSales' : 'operatingExpenses';
        if (Math.abs(amount) < 0.001) continue;

        let entry = lineMap.get(mapping.groupAccountId);
        if (!entry) {
          entry = { groupAccountId: mapping.groupAccountId, accountCode: mapping.groupAccountCode, accountName: mapping.groupAccountName, entities: {}, eliminationAmount: 0, consolidatedAmount: 0, category };
          lineMap.set(mapping.groupAccountId, entry);
        }
        if (!entry.entities[member.companyId]) entry.entities[member.companyId] = { amount: 0 };
        entry.entities[member.companyId]!.amount += amount;
      }
    }

    for (const elim of await getPostedEliminations(groupId, periodStart, periodEnd)) {
      const entry = lineMap.get(elim.groupAccountId);
      if (entry) entry.eliminationAmount += elim.credit - elim.debit;
    }

    const revenue: ConsolidatedLineItem[] = [];
    const costOfSales: ConsolidatedLineItem[] = [];
    const operatingExpenses: ConsolidatedLineItem[] = [];

    for (const entry of lineMap.values()) {
      let entitySum = 0;
      for (const e of Object.values(entry.entities)) entitySum += e.amount;
      entry.consolidatedAmount = entitySum + entry.eliminationAmount;
      const { category, ...lineItem } = entry;
      if (category === 'revenue') revenue.push(lineItem);
      else if (category === 'costOfSales') costOfSales.push(lineItem);
      else operatingExpenses.push(lineItem);
    }

    const sort = (a: ConsolidatedLineItem, b: ConsolidatedLineItem) => a.accountCode.localeCompare(b.accountCode);
    revenue.sort(sort); costOfSales.sort(sort); operatingExpenses.sort(sort);

    const totalRevenue = buildISTotals(revenue);
    const totalCostOfSales = buildISTotals(costOfSales);
    const totalOperatingExpenses = buildISTotals(operatingExpenses);

    const grossProfit: ConsolidatedISTotals = { entities: {}, eliminationAmount: 0, consolidatedAmount: 0 };
    for (const cid of new Set([...Object.keys(totalRevenue.entities), ...Object.keys(totalCostOfSales.entities)])) {
      grossProfit.entities[cid] = (totalRevenue.entities[cid] || 0) - (totalCostOfSales.entities[cid] || 0);
    }
    grossProfit.eliminationAmount = totalRevenue.eliminationAmount - totalCostOfSales.eliminationAmount;
    grossProfit.consolidatedAmount = totalRevenue.consolidatedAmount - totalCostOfSales.consolidatedAmount;

    const netProfit: ConsolidatedISTotals = { entities: {}, eliminationAmount: 0, consolidatedAmount: 0 };
    for (const cid of new Set([...Object.keys(grossProfit.entities), ...Object.keys(totalOperatingExpenses.entities)])) {
      netProfit.entities[cid] = (grossProfit.entities[cid] || 0) - (totalOperatingExpenses.entities[cid] || 0);
    }
    netProfit.eliminationAmount = grossProfit.eliminationAmount - totalOperatingExpenses.eliminationAmount;
    netProfit.consolidatedAmount = grossProfit.consolidatedAmount - totalOperatingExpenses.consolidatedAmount;

    return { groupId, periodStart, periodEnd, revenue, costOfSales, operatingExpenses, totalRevenue, totalCostOfSales, grossProfit, totalOperatingExpenses, netProfit };
  } catch (err) {
    log.error('Failed to generate consolidated income statement', { groupId, error: err }, 'accounting');
    throw err;
  }
}

export async function getConsolidatedBalanceSheet(
  groupId: string, asAtDate: string
): Promise<ConsolidatedBalanceSheet> {
  try {
    const members = await getGroupMembers(groupId);
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
        const mapping = mappings.get(String(r.account_id));
        if (!mapping) continue;
        const normalBal = String(r.normal_balance);
        const balance = normalBal === 'debit' ? Number(r.total_debit) - Number(r.total_credit) : Number(r.total_credit) - Number(r.total_debit);
        if (Math.abs(balance) < 0.01) continue;
        let entry = lineMap.get(mapping.groupAccountId);
        if (!entry) {
          entry = { groupAccountId: mapping.groupAccountId, accountCode: mapping.groupAccountCode, accountName: mapping.groupAccountName, entities: {}, eliminationAmount: 0, consolidatedAmount: 0, category: mapping.groupAccountType, normalBalance: mapping.groupNormalBalance };
          lineMap.set(mapping.groupAccountId, entry);
        }
        entry.entities[member.companyId] = (entry.entities[member.companyId] || 0) + balance;
      }

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
        const reMapping = (await sql`
          SELECT gcm.group_account_id, ga.account_code, ga.account_name, ga.normal_balance
          FROM group_coa_mappings gcm
          JOIN group_accounts ga ON ga.id = gcm.group_account_id
          WHERE gcm.group_id = ${groupId}::UUID AND gcm.company_id = ${member.companyId}::UUID
            AND ga.account_type = 'equity' AND ga.account_subtype = 'retained_earnings'
          LIMIT 1
        `) as Row[];
        if (reMapping.length > 0) {
          const gaId = String(reMapping[0]!.group_account_id);
          let entry = lineMap.get(gaId);
          if (!entry) {
            entry = { groupAccountId: gaId, accountCode: String(reMapping[0]!.account_code), accountName: String(reMapping[0]!.account_name), entities: {}, eliminationAmount: 0, consolidatedAmount: 0, category: 'equity', normalBalance: String(reMapping[0]!.normal_balance) };
            lineMap.set(gaId, entry);
          }
          entry.entities[member.companyId] = (entry.entities[member.companyId] || 0) + retainedEarnings;
        }
      }
    }

    for (const elim of await getPostedEliminations(groupId, '1900-01-01', asAtDate)) {
      const entry = lineMap.get(elim.groupAccountId);
      if (!entry) continue;
      entry.eliminationAmount += entry.normalBalance === 'debit' ? elim.debit - elim.credit : elim.credit - elim.debit;
    }

    const assets: ConsolidatedBSLineItem[] = [];
    const liabilities: ConsolidatedBSLineItem[] = [];
    const equity: ConsolidatedBSLineItem[] = [];

    for (const raw of lineMap.values()) {
      let entitySum = 0;
      for (const v of Object.values(raw.entities)) entitySum += v;
      raw.consolidatedAmount = entitySum + raw.eliminationAmount;
      const { category, normalBalance: _nb, ...lineItem } = raw;
      if (category === 'asset') assets.push(lineItem);
      else if (category === 'liability') liabilities.push(lineItem);
      else if (category === 'equity') equity.push(lineItem);
    }

    const sort = (a: ConsolidatedBSLineItem, b: ConsolidatedBSLineItem) => a.accountCode.localeCompare(b.accountCode);
    assets.sort(sort); liabilities.sort(sort); equity.sort(sort);

    return { groupId, asAtDate, assets, liabilities, equity, totalAssets: buildBSTotals(assets), totalLiabilities: buildBSTotals(liabilities), totalEquity: buildBSTotals(equity) };
  } catch (err) {
    log.error('Failed to generate consolidated balance sheet', { groupId, error: err }, 'accounting');
    throw err;
  }
}
