/**
 * Persist what a GL account merge moved.
 *
 * Before this existed, the only record of a merge was `linesRepointed` — a
 * count — in `mcp_tool_calls.result`, beside an `args_hash` that is a sha256
 * and so does not give the arguments back either. The single forensic handle
 * was `gl_journal_lines.updated_at` falling inside the tool call's window:
 * undocumented, unindexed, and destroyed by the next write to those rows.
 *
 * That made a wrong merge unrecoverable in practice, because merging BACK does
 * not undo one. A reverse merge moves the target's original lines too, so the
 * two populations the first merge fused stay fused. Only the identity of the
 * lines that moved can separate them, and that is what this writes.
 *
 * `merged_by` is TEXT with no foreign key: `users.id` is `character varying(255)`
 * with a `gen_random_uuid()::text` default, so a uuid-typed FK to it — or a
 * `${param}::UUID` cast against it — fails. The uuid side is cast, never that one.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { MergeAccount } from './accountMergeGuards';
import type { PostingActorOpts } from './journalEntryMeta';

export interface AccountMergeRecordInput {
  companyId: string;
  source: MergeAccount;
  target: MergeAccount;
  linesRepointed: number;
  entriesAffected: number;
  /** Every moved line, in a stable order. This is the point of the table. */
  movedLineIds: string[];
  /** sha256 over the same ids — what the dry run printed and a reader signed. */
  movedLinesDigest: string;
  reparentedAccountIds: string[];
  relevelledAccountIds: string[];
  levelDelta: number;
  userId?: string;
  actor?: PostingActorOpts;
  postedThrough: string | null;
}

export async function recordAccountMerge(input: AccountMergeRecordInput): Promise<string> {
  const rows = (await sql`
    INSERT INTO gl_account_merges (
      company_id, source_account_id, target_account_id,
      source_account_code, target_account_code,
      source_account_subtype, target_account_subtype,
      lines_repointed, entries_affected,
      moved_line_ids, moved_line_ids_digest,
      reparented_account_ids, relevelled_account_ids, level_delta,
      merged_by, actor_type, actor_token_jti, posted_through
    ) VALUES (
      ${input.companyId}::UUID, ${input.source.id}::UUID, ${input.target.id}::UUID,
      ${input.source.accountCode}, ${input.target.accountCode},
      ${input.source.accountSubtype}, ${input.target.accountSubtype},
      ${input.linesRepointed}, ${input.entriesAffected},
      ${input.movedLineIds}::uuid[], ${input.movedLinesDigest},
      ${input.reparentedAccountIds}::uuid[], ${input.relevelledAccountIds}::uuid[],
      ${input.levelDelta},
      ${input.userId ?? null}::TEXT, ${input.actor?.actorType ?? null},
      ${input.actor?.actorTokenJti ?? null},
      ${input.postedThrough}::TIMESTAMPTZ
    )
    RETURNING id
  `) as { id: string }[];

  const id = rows[0]?.id;
  if (!id) {
    // Not recoverable by carrying on: a merge whose moved lines were not
    // recorded is the irreversible state this table exists to prevent, so the
    // throw unwinds the whole merge with it.
    throw new Error('Failed to record the account merge — nothing was written.');
  }
  log.info('Recorded GL account merge', {
    companyId: input.companyId, mergeId: id, lines: input.linesRepointed,
  }, 'accounting');
  return String(id);
}
