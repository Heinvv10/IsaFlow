/**
 * The plan hash that binds a budget write's live call to ITS dry run (MCP budget tools): a sha256 over the
 * version, the kind of write (a set mode, or a restore and its snapshot), the version token the plan was made
 * against, and every cell the plan changes with its value and source BEFORE and the value AFTER. The live call
 * recomputes the plan from what it reads now and refuses unless the hashes match, so it never applies a plan
 * the caller did not see: another mode, other cells, or cells that moved since (also within one transaction,
 * where the version token cannot move: every budget write sets updated_at to the transaction's now()).
 */
import { createHash } from 'node:crypto';

export interface HashedCell { key: string; before: number | null; beforeSource: string | null; after: number | null }

export function budgetPlanHash(versionId: string, kind: string, token: string, cells: readonly HashedCell[]): string {
  const body = JSON.stringify([versionId.toLowerCase(), kind, token, cells.map((c) => [c.key, c.before, c.beforeSource, c.after])]);
  return createHash('sha256').update(body).digest('hex');
}

/**
 * The plan hash of a write that is not a list of cells (set_budget_drivers, PR 3): the same binding over the
 * version, the kind of write, the token, and `plan`, the caller's canonical JSON of what it will do and the
 * state it reads before (the version's driver lines, planned hires and cells). It does NOT bind the values a
 * recompute will produce (a per_head row reads payroll headcount on its own write): the live reply lists those.
 */
export function budgetStatePlanHash(versionId: string, kind: string, token: string, plan: unknown): string {
  return createHash('sha256').update(JSON.stringify([versionId.toLowerCase(), kind, token, plan])).digest('hex');
}
