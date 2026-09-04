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
import { digestLineIds, previewAccountMerge } from './accountMergePreview';
import { recordAccountMerge } from './accountMergeRecord';
import { lockGlAccountsForUpdate } from './glAccountLock';
import type { PostingActorOpts } from './journalEntryMeta';

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
  /** The `gl_account_merges` row that records exactly which lines moved. */
  mergeRecordId: string;
  /** sha256 over the moved line ids — compare against the dry run's. */
  movedLinesDigest: string;
}

export async function repointMovableLines(
  companyId: string, sourceId: string, targetId: string,
): Promise<string[]> {
  const rows = (await sql`
    UPDATE gl_journal_lines l
       SET gl_account_id = ${targetId}::UUID, updated_at = NOW()
      FROM gl_journal_entries e
      LEFT JOIN fiscal_periods fp
        ON fp.id = e.fiscal_period_id AND fp.company_id = ${companyId}::UUID
     WHERE l.company_id = ${companyId}::UUID
       AND l.gl_account_id = ${sourceId}::UUID
       AND e.id = l.journal_entry_id
       AND (e.status <> 'posted'
            OR (e.fiscal_period_id IS NOT NULL AND fp.status = 'open'))
    RETURNING l.id
  `) as { id: string }[];
  return rows.map((r) => String(r.id)).sort();
}

export async function mergeAccounts(
  companyId: string, sourceId: string, targetId: string,
  userId?: string, actor?: PostingActorOpts,
): Promise<MergeAccountsResult> {
  // Locked FIRST, so everything below reads a state no concurrent merge can
  // change under it — `lockGlAccountsForUpdate` takes the rows in ascending id
  // order under a 5s lock_timeout, which is what makes two opposite merges a
  // clean wait rather than a deadlock or an unbounded stall inside the
  // registry's savepoint.
  await lockGlAccountsForUpdate(companyId, [sourceId, targetId]);

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
  //
  // The status/period predicate is DUPLICATED from
  // `accountMergeFigures.classifySourceLines`, and the two are kept in step by
  // an executable check rather than by memory: `accountMergeRecordDb.test.ts >
  // the classifier and the write-time predicate select the SAME rows`
  // enumerates both sides and compares them by id. The count check below
  // catches drift in how MANY rows move; only that test catches a same-count
  // substitution that changes WHICH. They are not extracted into a shared
  // fragment because a tagged template cannot take one without concatenating
  // SQL in JavaScript, which this repo forbids outright.
  //
  // Repeated at write time. Classification
  // and this UPDATE are two statements: a journal committed between them — or a
  // period closed between them — would otherwise be moved without ever having
  // been classified, which is the exact inverse of the invariant the skip list
  // documents. With the predicate, such a row is left behind; the count check
  // below then aborts the whole merge rather than performing half of one.
  const movedLineIds = await repointMovableLines(companyId, sourceId, targetId);

  // Either number differing means the ledger moved under the preview. Throwing
  // unwinds the savepoint and leaves nothing written — an all-or-nothing merge
  // is the only kind that leaves the books coherent.
  if (movedLineIds.length !== preview.linesToRepoint) {
    throw new AccountMergeError(
      `The ledger changed while this merge was being prepared: ${preview.linesToRepoint} lines `
      + `were classified as movable and ${movedLineIds.length} were still movable at the write. `
      + 'Nothing has been changed. Re-run the dry run.',
      'ledger_moved_during_merge',
    );
  }

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
  let relevelled: { id: string }[] = [];
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
    `) as { id: string }[];
  }

  // Deactivated, not deleted. The account keeps its code, its history and its
  // external references; it simply stops appearing in pickers and carries zero.
  await sql`
    UPDATE gl_accounts SET is_active = false, updated_at = NOW()
     WHERE id = ${sourceId}::UUID AND company_id = ${companyId}::UUID
  `;

  cache.invalidatePrefix(`${companyId}:gl-accounts`);
  clearSystemAccountCache(companyId);

  // The record is what makes this recoverable. Merging back does NOT undo a
  // merge — a reverse merge carries the target's original lines with it — so
  // the identity of the lines that moved is the only thing that can separate
  // the two populations again.
  const movedLinesDigest = digestLineIds(movedLineIds);
  const mergeRecordId = await recordAccountMerge({
    companyId, source, target,
    linesRepointed: movedLineIds.length,
    entriesAffected: preview.entriesTotal,
    movedLineIds,
    movedLinesDigest,
    reparentedAccountIds: movedRootIds,
    relevelledAccountIds: relevelled.map((r) => String((r as { id: string }).id)),
    levelDelta,
    userId,
    actor,
    postedThrough: preview.postedThrough,
  });

  return {
    sourceAccountId: sourceId,
    sourceAccountCode: source.accountCode,
    targetAccountId: targetId,
    targetAccountCode: target.accountCode,
    linesRepointed: movedLineIds.length,
    entriesAffected: preview.entriesTotal,
    childAccountsReparented: reparented.length,
    descendantsRelevelled: relevelled.length,
    sourceDeactivated: true,
    targetPostedNet: preview.targetAfter.postedNet,
    postedThrough: preview.postedThrough,
    mergeRecordId,
    movedLinesDigest,
  };
}
