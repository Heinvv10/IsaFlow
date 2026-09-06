/**
 * Builds exactly what a share link renders.
 *
 * Same builder as the authenticated route (pages/api/accounting/reports-pack.ts)
 * so a shared pack and an on-screen pack cannot drift: one figure source, one
 * assembler. What differs is the commentary query, which selects approved_text
 * and filters on status = 'approved'. A draft has no path into this function's
 * return value — not a hidden field, not a flag the caller could flip.
 */
import { sql, type DbRow } from '@/lib/neon';
import {
  getFinancialFigures, unclassifiedWarning, totalEquity,
} from '@/modules/accounting/services/gl/financialFiguresService';
import {
  buildReportPack, type ReportPack, type ReportPackInput,
} from '@/modules/accounting/services/reports/reportPackService';
import { getCompanyName } from '@/modules/accounting/services/reports/companyName';
import { canonicalParamsHash } from './shareParams';
import type { ResolvedShareLink } from './shareResolver';

export interface PublishedCommentary {
  sectionRef: string;
  rowRef: string;
  text: string;
}

export interface SharedPack {
  companyName: string;
  period: { from: string; to: string };
  pack: ReportPack;
  commentary: PublishedCommentary[];
  unclassifiedAccounts: ReturnType<typeof unclassifiedWarning>;
}

/** APPROVED TEXT ONLY. The status filter and the column are both required:
 *  the column is empty until an approval writes it, and the status filter stops
 *  a withdrawn approval (status moved back to 'draft') still being served. */
async function loadApprovedCommentary(companyId: string, paramsHash: string): Promise<PublishedCommentary[]> {
  const rows = (await sql`
    SELECT section_ref, row_ref, approved_text
    FROM report_commentary
    WHERE company_id = ${companyId}::uuid
      AND report_kind = 'pack'
      AND params_hash = ${paramsHash}
      AND status = 'approved'
      AND approved_text IS NOT NULL
    ORDER BY section_ref, row_ref
  `) as DbRow[];
  return rows.map(r => ({
    sectionRef: String(r.section_ref),
    rowRef: String(r.row_ref),
    text: String(r.approved_text),
  }));
}

export async function buildSharedPack(link: ResolvedShareLink): Promise<SharedPack> {
  const { companyId, params } = link;
  const [figures, companyName, commentary] = await Promise.all([
    getFinancialFigures(companyId, params.from, params.to),
    getCompanyName(companyId),
    loadApprovedCommentary(companyId, canonicalParamsHash(params)),
  ]);

  const { period, cumulative } = figures;
  const input: ReportPackInput = {
    companyName,
    period: `${params.from} to ${params.to}`,
    revenue: period.revenue,
    costOfSales: period.costOfSales,
    operatingExpenses: period.operatingExpenses,
    netProfit: period.netProfit,
    totalAssets: cumulative.totalAssets,
    totalLiabilities: cumulative.totalLiabilities,
    totalEquity: totalEquity(figures),
    currentAssets: cumulative.currentAssets,
    currentLiabilities: cumulative.currentLiabilities,
    cash: cumulative.cash,
    accountsReceivable: cumulative.accountsReceivable,
    accountsPayable: cumulative.accountsPayable,
    inventory: cumulative.inventory,
    otherIncome: period.otherIncome,
    otherExpenses: period.otherExpenses,
  };

  return {
    companyName,
    period: { from: params.from, to: params.to },
    pack: buildReportPack(params.type, input, params.from, params.to),
    commentary,
    unclassifiedAccounts: unclassifiedWarning(cumulative),
  };
}
