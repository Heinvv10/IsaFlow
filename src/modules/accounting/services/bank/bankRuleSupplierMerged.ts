/**
 * Supplier rules left on a merged-away supplier (#1882 fix-verify, M1). A supplier merge leaves the source's bank rules on it, by
 * decision (core/supplierMergeOpenWork: rules are the merged-away supplier's own, and folding two sets is a product decision nobody
 * has made). The rule sweep must then not post to that supplier: each such line is a `supplier_merged` skip, counted on its own
 * (not as "raced" or as a refund over the ceiling), and the run names each rule, the supplier it names and the survivor, so the
 * person can re-point the rule.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** One rule the sweep skipped because its supplier was merged into `survivorName` (null: plainly deleted). */
export interface MergedRuleSkip { ruleName: string; supplierName: string; survivorName: string | null; lines: number }

export class MergedRuleSkips {
  private readonly byRule = new Map<string, { supplierId: string; lines: number }>();

  add(ruleName: string, supplierId: string): void {
    const seen = this.byRule.get(ruleName);
    if (seen) seen.lines += 1;
    else this.byRule.set(ruleName, { supplierId, lines: 1 });
  }

  get count(): number {
    return [...this.byRule.values()].reduce((sum, r) => sum + r.lines, 0);
  }

  /** The rules, with their supplier's and its survivor's names (company-scoped reads). */
  async describe(companyId: string): Promise<MergedRuleSkip[]> {
    if (this.byRule.size === 0) return [];
    const ids = [...new Set([...this.byRule.values()].map((r) => r.supplierId))];
    const rows = (await sql`
      SELECT s.id::TEXT AS id, s.name, sv.name AS survivor
        FROM suppliers s LEFT JOIN suppliers sv ON sv.id = s.merged_into_id AND sv.company_id = s.company_id
       WHERE s.company_id = ${companyId}::UUID AND s.id = ANY(${ids}::UUID[])
    `) as DbRow[];
    const named = new Map(rows.map((r) => [String(r.id), r]));
    return [...this.byRule.entries()].map(([ruleName, r]) => ({
      ruleName,
      supplierName: String(named.get(r.supplierId)?.name ?? 'its supplier'),
      survivorName: named.get(r.supplierId)?.survivor == null ? null : String(named.get(r.supplierId)!.survivor),
      lines: r.lines,
    }));
  }
}
