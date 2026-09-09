/**
 * The rules a proposed `parent_account_id` must satisfy, shared by the two
 * code paths that can set one: `createAccount` (a NEW child) and
 * `reclassifyAccount` (an EXISTING account being moved).
 *
 * They were only ever enforced on the reclassify path. `createAccount` checked
 * that the parent existed in the company and nothing else — so attaching a new
 * child to an account that already has postings was allowed, and that is
 * migration 484's defect: the balance sheet filters parent headers out of its
 * calculation, so the parent's own balance silently disappears from the
 * statements. Reachable from the Add Account dialog, the POST route, and now
 * the `create_gl_account` MCP tool.
 *
 * The cycle check is NOT here: it only applies when moving an existing account
 * (a freshly created one has no descendants to close a loop through), and it
 * needs the moving account's id, which `createAccount` does not yet have.
 */

import { sql } from '@/lib/neon';
import { BALANCE_SHEET_LEAF_LEVEL } from './isReportVisibleLeaf';

/**
 * Mirrors `MAX_TREE_DEPTH` in accountReclassifyService, which caps the two
 * recursive walks. Capping the walks but not the level they produce is
 * asymmetric: a chart nested past this point would keep taking deeper levels
 * that the cycle check can no longer see past. The deepest seeded template is
 * 3 levels, so this refuses nothing real.
 */
const MAX_TREE_DEPTH = 32;

export interface ParentCheckResult {
  /** `parent.level + 1` — the level the child must take. */
  childLevel: number;
}

export class ParentAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParentAccountError';
  }
}

/**
 * @param childType the account_type of the account being placed under `parentId`.
 * @throws ParentAccountError with a reason the caller can surface verbatim.
 */
export async function assertParentUsable(
  companyId: string,
  parentId: string,
  childType: string,
): Promise<ParentCheckResult> {
  const rows = (await sql`
    SELECT id, account_code, account_type, level FROM gl_accounts
     WHERE id = ${parentId}::UUID AND company_id = ${companyId}::UUID
     LIMIT 1
  `) as { id: string; account_code: string; account_type: string; level: number }[];

  const parent = rows[0];
  // Same text as a genuine miss: a distinct "belongs to another company" reply
  // would be a cross-tenant existence oracle.
  if (!parent) throw new ParentAccountError(`Parent account ${parentId} not found`);

  if (parent.account_type !== childType) {
    throw new ParentAccountError(
      `Parent ${parent.account_code} is an ${parent.account_type} account — ` +
        `it cannot hold an ${childType} account`,
    );
  }

  // The leaf rule, and ONLY where it actually bites.
  //
  // `balanceSheetService` includes an account when `level >= 3 OR NOT EXISTS
  // (child)` — so giving a child to a posted account at level 1 or 2 silently
  // drops its balance from the statements (migration 484), while a posted
  // account at level 3 or deeper keeps its balance whether or not it has
  // children.
  //
  // The first version of this guard refused EVERY posted parent. That is the
  // safer-looking rule and the wrong one: converting a used level-3 account
  // into a header and posting to its children is ordinary chart maintenance
  // (Sage-imported charts arrive that way), and refusing it would have broken
  // the Add Account dialog for a case that loses nothing. `validateLeafAccount`
  // still stops anyone POSTING to the parent afterwards — that is an explicit
  // refusal at post time, not silent loss, and it is the accountant's call.
  if (Number(parent.level) < BALANCE_SHEET_LEAF_LEVEL) {
    const posted = (await sql`
      SELECT 1 FROM gl_journal_lines
       WHERE gl_account_id = ${parentId}::UUID AND company_id = ${companyId}::UUID
       LIMIT 1
    `) as unknown[];
    if (posted.length > 0) {
      throw new ParentAccountError(
        `Parent ${parent.account_code} is a level-${parent.level} account with journal lines ` +
          'posted to it. Giving it a child would turn it into a header, and the balance sheet ' +
          'excludes headers above level 3 — its own balance would disappear from the statements.',
      );
    }
  }

  const childLevel = Number(parent.level) + 1;
  if (childLevel > MAX_TREE_DEPTH) {
    throw new ParentAccountError(
      `Parent ${parent.account_code} is already ${parent.level} levels deep — ` +
        `the chart of accounts is limited to ${MAX_TREE_DEPTH} levels`,
    );
  }
  return { childLevel };
}
