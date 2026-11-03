/**
 * The approve dialog's cost-centre labels (follow-up B of PR #1065). Labour
 * lines carry the employee's CC1 (`cc1Id`), so one account can be listed once
 * per centre; the journal-plan route adds `costCentres` — code and name for
 * every CC1 on the plan's, the posted journal's and the replaced journal's
 * lines — so each row can say which centre it is. Company-scoped, and NOT
 * filtered on is_active: a posted line may name a centre deactivated since.
 * Display only: not in the plan hash, and nothing posts from it.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { JournalPlanPreview } from './payrollApprovalGate';

export interface CostCentreLabel { code: string; name: string }
export type LabelledJournalPlanPreview = JournalPlanPreview & { costCentres: Record<string, CostCentreLabel> };

export async function withCostCentreLabels(companyId: string, preview: JournalPlanPreview): Promise<LabelledJournalPlanPreview> {
  const ids = [...new Set([...preview.plan.lines, ...(preview.posted?.lines ?? []), ...(preview.replaces?.lines ?? [])]
    .map((l) => l.cc1Id).filter((id): id is string => id != null))];
  const costCentres: Record<string, CostCentreLabel> = {};
  if (ids.length > 0) {
    const rows = (await sql`
      SELECT id, code, name FROM cost_centres
       WHERE company_id = ${companyId}::uuid AND id = ANY(${ids}::uuid[])
    `) as DbRow[];
    for (const r of rows) costCentres[String(r.id)] = { code: String(r.code), name: String(r.name) };
  }
  return { ...preview, costCentres };
}
