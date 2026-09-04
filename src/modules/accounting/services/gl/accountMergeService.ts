/**
 * Merge one GL account into another: repoint its ledger lines, move its
 * children onto the target, and deactivate it.
 *
 * This exists because Velocity Fibre carries two accounts per side of the
 * subledger — a Sage-era `SYS-7` / `SYS-8` pair holding one population and an
 * agent-era `1120` / `2110` pair holding another — and every cash-application
 * path writes only to the second, so tens of millions of rand sit in accounts
 * the write path cannot reach. The merge is the remedy.
 *
 * It is ALSO a production data correction, and running one is a human decision.
 * Nothing here is invoked unattended: the caller is expected to read
 * `previewAccountMerge` first, and the MCP tool refuses the live path whenever
 * the preview reports a row that cannot move.
 *
 * The accounting property that makes this safe: a repoint changes no debit and
 * no credit, only which account carries it, so the company's trial balance is
 * identical afterwards. What it DOES change is per-account balances, every
 * report grouped by account, and any comparative already signed — which is why
 * a line in a closed period refuses rather than moves.
 *
 * Nothing is deleted. `gl_journal_lines` are updated in place, and the source
 * account stays in the chart, deactivated, carrying zero.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { cache } from '@/lib/cache';
import { clearSystemAccountCache } from './systemAccountResolver';
import {
  AccountMergeError, MAX_TREE_DEPTH, assertMergeable, loadMergeAccount,
} from './accountMergeGuards';
import { previewAccountMerge } from './accountMergePreview';

export {
  AccountMergeError,
  CONFIGURATION_REFERENCE_EXCLUSIONS,
  type MergeRefusalCode,
  type ConfigurationReference,
} from './accountMergeGuards';

export interface MergeAccountsResult {
  sourceAccountId: string;
  sourceAccountCode: string;
  targetAccountId: string;
  targetAccountCode: string;
  /** Journal LINES moved onto the target, all statuses. */
  linesRepointed: number;
  /** Journal ENTRIES those lines belonged to. */
  entriesAffected: number;
  /** Direct children reparented onto the target. The subtree moved with them. */
  childAccountsReparented: number;
  /** Levels shifted across the whole subtree, direct children included. */
  descendantsRelevelled: number;
  sourceDeactivated: true;
  targetPostedNet: number;
  postedThrough: string | null;
}

export async function mergeAccounts(
  companyId: string, sourceId: string, targetId: string,
): Promise<MergeAccountsResult> {
  const source = await loadMergeAccount(companyId, sourceId);
  const target = await loadMergeAccount(companyId, targetId);
  // The same generic text a genuine miss gets: a distinct "belongs to another
  // company" reply is an existence oracle.
  if (!source || !target) throw new AccountMergeError('Not found', 'account_not_found');

  // Re-run every request-level guard here rather than trusting the caller to
  // have previewed. The preview and the write are two round trips and the chart
  // can move between them.
  await assertMergeable(companyId, source, target);

  const preview = await previewAccountMerge(companyId, sourceId, targetId);
  if (preview.blocked) {
    throw new AccountMergeError(
      `${preview.skipsTotal} journal line${preview.skipsTotal === 1 ? '' : 's'} on `
      + `${source.accountCode} cannot be repointed (`
      + `${[...new Set(preview.skips.map((s) => s.reason))].join(', ')}). `
      + 'A control-account merge that leaves part of its balance behind is worse than one that '
      + 'does not run, so nothing has been changed. Run the dry run for the affected entries.',
      'lines_cannot_be_repointed',
    );
  }

  const levelDelta = target.level - source.level;

  log.info('Merging GL accounts', {
    companyId, sourceId, targetId, lines: preview.linesToRepoint,
  }, 'accounting');

  // The ledger. `gl_account_balances` follows on its own: trg_gl_jl_balance_update
  // recomputes the source and deltas the target for every row updated here.
  // Explicitly company-scoped as well as id-scoped — the line ids came from a
  // company-scoped read, and the predicate says so at the write too.
  // Every line on the source, not a sampled subset: `blocked` is false, so the
  // preview classified ALL of them as movable. Selecting by the preview's
  // `entries` would have been wrong — that list is capped at 200 for the
  // response, and a merge that silently moved the first 200 of 3,669 lines is
  // exactly the half-merge this service refuses to perform on purpose.
  const repointed = (await sql`
    UPDATE gl_journal_lines
       SET gl_account_id = ${targetId}::UUID, updated_at = NOW()
     WHERE company_id = ${companyId}::UUID
       AND gl_account_id = ${sourceId}::UUID
    RETURNING id
  `) as unknown[];

  // Children move onto the target, and the whole subtree takes the level shift —
  // without it, descendants keep the depth they had under the old parent and
  // several reports group on `level`.
  const reparented = (await sql`
    UPDATE gl_accounts
       SET parent_account_id = ${targetId}::UUID, updated_at = NOW()
     WHERE company_id = ${companyId}::UUID AND parent_account_id = ${sourceId}::UUID
    RETURNING id
  `) as { id: string }[];
  const movedRootIds = reparented.map((r) => String(r.id));

  // Seeded from the accounts that actually moved, NOT from "everything under
  // the target" — the target's own existing children did not move and must keep
  // the level they have.
  let relevelled: unknown[] = [];
  if (movedRootIds.length > 0 && levelDelta !== 0) {
    relevelled = (await sql`
      WITH RECURSIVE subtree AS (
        SELECT id, 1 AS depth FROM gl_accounts
         WHERE id = ANY(${movedRootIds}::uuid[]) AND company_id = ${companyId}::UUID
        UNION ALL
        SELECT ch.id, s.depth + 1 FROM gl_accounts ch
          JOIN subtree s ON ch.parent_account_id = s.id
         WHERE ch.company_id = ${companyId}::UUID AND s.depth < ${MAX_TREE_DEPTH}
      )
      UPDATE gl_accounts SET level = level + ${levelDelta}, updated_at = NOW()
       WHERE company_id = ${companyId}::UUID
         AND id IN (SELECT id FROM subtree)
      RETURNING id
    `) as unknown[];
  }

  // Deactivated, not deleted. The account keeps its code, its history and its
  // external references; it simply stops appearing in pickers and carries zero.
  await sql`
    UPDATE gl_accounts SET is_active = false, updated_at = NOW()
     WHERE id = ${sourceId}::UUID AND company_id = ${companyId}::UUID
  `;

  cache.invalidatePrefix(`${companyId}:gl-accounts`);
  clearSystemAccountCache(companyId);

  return {
    sourceAccountId: sourceId,
    sourceAccountCode: source.accountCode,
    targetAccountId: targetId,
    targetAccountCode: target.accountCode,
    linesRepointed: repointed.length,
    entriesAffected: preview.entriesTotal,
    childAccountsReparented: reparented.length,
    descendantsRelevelled: relevelled.length,
    sourceDeactivated: true,
    targetPostedNet: preview.targetAfter.postedNet,
    postedThrough: preview.postedThrough,
  };
}
