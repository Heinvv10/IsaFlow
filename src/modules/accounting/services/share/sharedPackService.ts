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
import { unclassifiedWarning } from '@/modules/accounting/services/gl/financialFiguresService';
import { readReportPackInput } from '@/modules/accounting/services/reports/reportPackDataService';
import { buildReportPack, type ReportPack } from '@/modules/accounting/services/reports/reportPackService';
import { getCompanyName } from '@/modules/accounting/services/reports/companyName';
import { canonicalParamsHash } from '@/modules/accounting/services/reports/packParamsHash';
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
  // THE SAME INPUT THE PDF, THE DECK AND THE SCREEN ARE BUILT FROM — see
  // `readReportPackInput`. It was assembled here by hand, without the cash
  // flows. One read after the other, because that producer takes a savepoint
  // around its cash-flow read and a query landing inside it is refused when
  // that read fails.
  const companyName = await getCompanyName(companyId);
  const { input, figures } = await readReportPackInput(companyId, companyName, params.from, params.to);
  const commentary = await loadApprovedCommentary(companyId, canonicalParamsHash(params));

  return {
    companyName,
    period: { from: params.from, to: params.to },
    pack: buildReportPack(params.type, input, params.from, params.to),
    commentary,
    unclassifiedAccounts: unclassifiedWarning(figures.cumulative),
  };
}
