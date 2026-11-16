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
