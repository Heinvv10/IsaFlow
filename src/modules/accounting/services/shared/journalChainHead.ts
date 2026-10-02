/**
 * The HEAD of a journal's reversal chain: the one posted entry in it nobody
 * has reversed, and whether the chain is standing in the ledger.
 *
 * Reversing is additive — reversing O posts R with reversal_of_id = O,
 * reversing R posts R2 — and `ux_gl_je_reversal_of` keeps it linear, so
 * exactly one entry is unreversed and O is standing when that head sits at an
 * ODD depth (O itself is depth 1). `O.reversed_at` cannot say it: after
 * O <- R <- R2 the ledger carries O again through R2 while O stays stamped.
 *
 * Every flow that takes a document's journal OUT of the ledger (cancel, void,
 * re-import, soft delete) must therefore reverse the HEAD, not O: reversing O
 * again throws "already reversed", and skipping it because O is stamped leaves
 * the document in the GL. Extracted from core/softDeleteJournalService (K-053)
 * for D8 so every such flow asks the same question.
 *
 * CYCLE GUARD: the unique index forbids two reversals of one entry, not a loop
 * (X.reversal_of_id = R and R.reversal_of_id = X are distinct values). A forged
 * loop would recurse for ever, so the walk carries its path and stops at the
 * first repeat or at MAX_CHAIN_DEPTH, and the result says `broken`.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** Far past any chain built by hand; a guard, not a limit anyone meets. */
export const MAX_CHAIN_DEPTH = 64;

export type JournalChainHead =
  /** The one unreversed entry; `standing` when the root is in the ledger through it. */
  | { kind: 'head'; id: string; standing: boolean }
  /** Not one unreversed posted entry (a voided reversal empties it), or a loop. */
  | { kind: 'broken'; unreversed: number; cyclic: boolean };

/**
 * The chain from `rootId`, a POSTED entry of `companyId`. Null when the root is
 * not a posted entry of this company (a draft has no chain; it is not in the
 * ledger). Reads only — the caller locks the head it is about to reverse.
 */
export async function findJournalChainHead(
  companyId: string,
  rootId: string,
): Promise<JournalChainHead | null> {
  const rows = (await sql`
    WITH RECURSIVE chain AS (
      SELECT id, reversed_at, 1 AS depth, ARRAY[id] AS path, false AS cyclic
      FROM gl_journal_entries
      WHERE id = ${rootId}::UUID AND company_id = ${companyId}::UUID AND status = 'posted'
      UNION ALL
      SELECT j.id, j.reversed_at, chain.depth + 1, chain.path || j.id, j.id = ANY(chain.path)
      FROM gl_journal_entries j
      JOIN chain ON j.reversal_of_id = chain.id
      WHERE j.company_id = ${companyId}::UUID AND j.status = 'posted'
        AND NOT chain.cyclic AND chain.depth < ${MAX_CHAIN_DEPTH}
    )
    SELECT id, depth, reversed_at IS NULL AS unreversed, cyclic FROM chain
  `) as DbRow[];
  if (rows.length === 0) return null;

  const cyclic = rows.some((r) => r.cyclic === true || Number(r.depth) >= MAX_CHAIN_DEPTH);
  const open = rows.filter((r) => r.unreversed === true && r.cyclic !== true);
  if (cyclic || open.length !== 1) return { kind: 'broken', unreversed: open.length, cyclic };
  return { kind: 'head', id: String(open[0]!.id), standing: Number(open[0]!.depth) % 2 === 1 };
}

/** One wording for a broken chain; each flow throws it as its own refusal type. */
export function brokenChainMessage(rootId: string, chain: { unreversed: number; cyclic: boolean }): string {
  const why = chain.cyclic
    ? 'loops back on itself'
    : `has ${chain.unreversed} un-reversed posted entries where there must be exactly one`;
  return `Journal entry ${rootId}'s reversal chain ${why}, so it cannot be reversed safely. `
    + 'Open that entry in the GL and repair its reversal chain first.';
}

/**
 * A broken chain where the flow has no refusal type of its own. Deliberately no
 * `readonly code`: a looped or emptied chain is damaged data, not a business
 * refusal for an agent to act on, so MCP answers it as an internal error.
 */
export class JournalChainBrokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalChainBrokenError';
  }
}

/**
 * The entry to reverse to take `rootId` OUT of the ledger, locked FOR UPDATE:
 * the chain head while the chain stands; null when it is already out (an odd
 * number of reversals), when the root is not a posted entry of this company, or
 * when the head was reversed concurrently between the walk and the lock (the
 * ledger has then moved under the caller, which reads it as nothing to do, as
 * soft delete does). A broken chain throws `refuse(message)`.
 */
export async function lockStandingChainHead(
  companyId: string,
  rootId: string,
  refuse: (message: string) => Error = (m) => new JournalChainBrokenError(m),
): Promise<string | null> {
  const chain = await findJournalChainHead(companyId, rootId);
  if (!chain) return null;
  if (chain.kind === 'broken') throw refuse(brokenChainMessage(rootId, chain));
  if (!chain.standing) return null;
  const [row] = (await sql`
    SELECT status, reversed_at FROM gl_journal_entries
    WHERE id = ${chain.id}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE
  `) as DbRow[];
  if (!row || row.status !== 'posted' || row.reversed_at != null) return null;
  return chain.id;
}
