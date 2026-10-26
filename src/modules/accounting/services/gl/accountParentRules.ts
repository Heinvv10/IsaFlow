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
import { log } from '@/lib/logger';
import {
  BALANCE_SHEET_LEAF_LEVEL, LEAF_RULE_ACCOUNT_TYPES, hasChildAccounts, isSubjectToLeafRule,
} from './isReportVisibleLeaf';
import { lockGlAccountsForUpdate } from './glAccountLock';
import { YEAR_END_JOURNAL_SOURCE } from './yearEndJournalSource';
import { lockSystemRoleWrites } from './systemRoleWriteLock';
import { holderAsParentRefusal, roleBarringChildren } from './roleTargetRules';

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
  // Role lock first (before any row lock below), and so that the holder check
  // judges a settled row: a Default Accounts save may be choosing this parent.
  await lockSystemRoleWrites(companyId);
  const rows = (await sql`
    SELECT id, account_code, account_type, level, account_subtype, is_system_account FROM gl_accounts
     WHERE id = ${parentId}::UUID AND company_id = ${companyId}::UUID
     LIMIT 1
  `) as { id: string; account_code: string; account_type: string; level: number;
    account_subtype: string | null; is_system_account: boolean }[];

  const parent = rows[0];
  // Same text as a genuine miss: a distinct "belongs to another company" reply
  // would be a cross-tenant existence oracle.
  if (!parent) throw new ParentAccountError(`Parent account ${parentId} not found`);

  const heldRole = roleBarringChildren(parent);
  if (heldRole) throw new ParentAccountError(holderAsParentRefusal(parent.account_code, heldRole));

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
  // Type-scoped for the same reason the merge and reclassification guards are:
  // only the balance sheet and the trend report carry the leaf rule, and both
  // select `account_type IN ('asset','liability','equity')`. Refusing a used
  // level-2 EXPENSE parent told the accountant its balance would leave the
  // statements, which is false — the income statement has no level filter — and
  // expense-chart tidying through the Add Account dialog is the commonest edit
  // of the three.
  //
  // The first version of this guard refused EVERY posted parent. That is the
  // safer-looking rule and the wrong one: converting a used level-3 account
  // into a header and posting to its children is ordinary chart maintenance
  // (Sage-imported charts arrive that way), and refusing it would have broken
  // the Add Account dialog for a case that loses nothing — the reports carry
  // a level-3 account whether or not it has children, so nothing disappears.
  // That is the whole justification. `validateLeafAccount` is NOT a second one:
  // it runs on the expense-claim posting route and nowhere else, and
  // `headerAccountGuard` refuses posts to level 1-2 headers only, so a later
  // post to a level-3 parent through any other path is not refused.
  if (isSubjectToLeafRule(Number(parent.level), parent.account_type)) {
    // LOCKED BEFORE THE READ, and this is what makes the verdict hold.
    //
    // The check and the INSERT/UPDATE sit in one request transaction, but the
    // INSERT's own FOR KEY SHARE on the parent is taken AFTER the verdict is
    // formed and this function never re-reads. So a reclassification that posts
    // the parent's first lines can commit in between: the write blocks on the
    // peer's FOR UPDATE, then proceeds on a verdict formed when the parent was
    // still empty, and the parent becomes exactly the invisible header this
    // guard exists to prevent. Taking the lock FIRST turns that into a wait —
    // the read below runs on the settled row and refuses.
    //
    // The mirror of `admitReclassification`'s lock, on the same rows, in the
    // same ascending-id idiom, and narrowed the same way: only a level 1-2
    // asset/liability/equity parent can lose anything, so an expense chart edit
    // still takes no lock. Both paths lock the ACCOUNT before any line lock, so
    // the two cannot cycle. Requires a request transaction (`withAuth` or the
    // MCP bearer pipeline) — every production caller of `createAccount` and
    // `reclassifyAccount` runs inside one.
    await lockGlAccountsForUpdate(companyId, [parentId]);
    // ALREADY A HEADER: a parent with a child is off both reports already, so
    // another child hides nothing new (VF's paycard umbrella, 2026-10-26: 40
    // children, and every further paycard was refused). The read is settled:
    // every writer that can take a child AWAY (reclassifyAccount, the bank
    // grouping PUT, an account merge, an import rollback's DELETE) takes the
    // role-write lock first, as this function did above, so "the last child
    // leaves" and "a new child arrives" serialise —
    // header-account-already-header.int.test.ts (c).
    if (await hasChildAccounts(companyId, parentId)) await warnIfHeaderHoldsMoney(companyId, parent);
    else await assertNoPostedLines(companyId, parent);
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

/**
 * The exemption admits a child to a header whose OWN lines are already off the balance sheet. When they do
 * not net to zero that is money the statements are missing today; this does not refuse (it hides nothing
 * new) but says so, so the header's balance gets moved to a leaf.
 */
export async function warnIfHeaderHoldsMoney(
  companyId: string, parent: { id: string; account_code: string },
): Promise<void> {
  // The balance sheet's own filters (balanceSheetService): posted, this company on both rows, no year-end close.
  const [row] = (await sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::TEXT AS net FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
     WHERE jl.gl_account_id = ${parent.id}::UUID AND jl.company_id = ${companyId}::UUID
       AND je.company_id = ${companyId}::UUID AND je.status = 'posted'
       AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
  `) as { net: string }[];
  if (row && Number(row.net) !== 0) {
    log.warn('Child added to a header that carries its own unreported balance', {
      companyId, parentId: parent.id, accountCode: parent.account_code, net: row.net,
    }, 'gl-accounts');
  }
}

/** Refuses a childless level 1-2 parent with lines: a child would make it a header the reports drop. */
async function assertNoPostedLines(
  companyId: string, parent: { id: string; account_code: string; account_type: string; level: number },
): Promise<void> {
  // `company_id` is LOAD-BEARING, not habit. Until migration 664 a journal
  // line could name this company's account while carrying another company's
  // `company_id` — `POST /api/accounting/journal-entries` wrote exactly that
  // — and rows from before it still can. `balanceSheetService` filters
  // `jl.company_id`, `ga.company_id` AND `je.company_id`, so such a line is
  // invisible to the report this guard protects; reading it here would refuse
  // a chart edit that loses nothing. Guard and reader must agree, and
  // `k051-cross-company-journal-line.int.test.ts` is what pins that.
  const posted = (await sql`
    SELECT 1 FROM gl_journal_lines
     WHERE gl_account_id = ${parent.id}::UUID AND company_id = ${companyId}::UUID
     LIMIT 1
  `) as unknown[];
  if (posted.length > 0) {
    throw new ParentAccountError(
      `Parent ${parent.account_code} is a level-${parent.level} ${parent.account_type} ` +
        'account with journal lines posted to it. Giving it a child would turn it into a ' +
        'header, and the balance sheet and the trend report select an account only when its ' +
        'level is 3 or higher or it has no children — its own balance would disappear from ' +
        'both.',
    );
  }
}

/**
 * Moving an account UP re-levels it and its whole subtree. A posted asset, liability or equity
 * parent that crosses from level 3 to below it becomes a header the balance sheet drops
 * (isReportVisibleLeaf), so the move is refused, as `assertParentUsable` refuses a child on one.
 * An account that was already a header is not newly hidden and does not block. Named limit: a journal
 * that posts to BOTH the moved account and an at-risk descendant can deadlock with the move (40P01, one
 * request fails and retries); neither commits a hidden header.
 */
export async function assertNoPostedParentHidden(companyId: string, id: string, delta: number): Promise<void> {
  // Two reads of the same predicate. The first finds the at-risk accounts without their lines; they are then
  // locked FOR UPDATE (ascending, under the role lock, like every chart edit), so a journal guard posting to one
  // waits for this request (gl/headerAccountGuard takes KEY SHARE on every parent). The second read, a fresh
  // statement, sees any line committed while this waited.
  const atRisk = async (withLines: boolean) => (await sql`
    WITH RECURSIVE subtree AS (
      SELECT id, 1 AS depth FROM gl_accounts WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
      UNION ALL
      SELECT ch.id, s.depth + 1 FROM gl_accounts ch JOIN subtree s ON ch.parent_account_id = s.id
       WHERE ch.company_id = ${companyId}::UUID AND s.depth < ${MAX_TREE_DEPTH}
    )
    SELECT ga.id, ga.account_code FROM subtree s JOIN gl_accounts ga ON ga.id = s.id AND ga.company_id = ${companyId}::UUID
     WHERE ga.account_type = ANY(${[...LEAF_RULE_ACCOUNT_TYPES]}::TEXT[])
       AND ga.level >= ${BALANCE_SHEET_LEAF_LEVEL} AND ga.level + ${delta} < ${BALANCE_SHEET_LEAF_LEVEL}
       AND EXISTS (SELECT 1 FROM gl_accounts ch WHERE ch.parent_account_id = ga.id AND ch.company_id = ${companyId}::UUID)
       AND (${!withLines}::BOOLEAN OR EXISTS (
         SELECT 1 FROM gl_journal_lines jl WHERE jl.gl_account_id = ga.id AND jl.company_id = ${companyId}::UUID))
     ORDER BY ga.account_code
  `) as { id: string; account_code: string }[];
  const candidates = await atRisk(false);
  if (candidates.length === 0) return;
  await lockGlAccountsForUpdate(companyId, candidates.map((c) => String(c.id)));
  const hidden = await atRisk(true);
  if (hidden[0]) {
    throw new ParentAccountError(
      `Moving this account would put ${hidden[0].account_code} above level ${BALANCE_SHEET_LEAF_LEVEL}. It has sub-accounts and `
        + 'journal lines posted to it, so it would become a header and its balance would leave the balance sheet.',
    );
  }
}
