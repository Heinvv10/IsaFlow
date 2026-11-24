/**
 * The PAYER's journal key (intercompany P4-E): 1027's cap-lock key on a journal chain ROOT, hashtextextended('<payer>:journal:<root>', 1027),
 * the key a receiver's clearing of an allocation message standing on that journal holds from before its liveness check until its commit.
 *
 * A LEAF on purpose (fix round 3, d): `gl/journalEntryReversalClaim` and `shared/journalChainHead` import it, and it imports neither (nor
 * `allocationUndoGate`, which imports it), so the chain walk up is its own SQL here rather than `findJournalChainRoot`.
 *
 * WHEN (fix round 3, MED): only for a chain an allocation message of THIS company stands on (its `source_journal_entry_id` is the root),
 * the one shape the undo gate's journal refusal can match. Round 2 took it for every journal of a company that had sent any allocation
 * message, so a flow that holds a journal row and then reverses it (an invoice or credit-note cancel, a soft delete, a payroll reversal)
 * reached the key AFTER the row while a GL reversal took key then row: 40P01. No other journal needs it: nothing can clear against it.
 * The question and the key are not atomic: a message SENT for this root after the question is not waited for; it is sent by the payer's own
 * payment flow, which a reversal of that payment's journal already serialises with on the journal row.
 *
 * ORDER (key, then journal row) holds for the GL route and every caller that reaches the key before it holds the journal row: a plain
 * `reverseJournalEntry` takes it in `claimJournalReversal` before the claim's row UPDATE; `lockJournalAndUnmatch` (the single and batch
 * void, the bank-line reversal of a document chain) and `lockChainHead` FOR UPDATE (the bank reallocation through `reversalTargetOf`, the
 * provisional void, the dismiss) take it before their row lock; a payer void takes its payment, journal and bill keys (`partnerClearedRefusal`)
 * before any journal row. The flows that lock a journal row BEFORE reaching the key (the customer invoice, credit note and supplier invoice
 * cancels, the soft delete: a row lock of their own, then the reversal) reverse only document journals no allocation message stands on (the
 * sender records the payment's journal or its batch's), so they take no key at all. Re-entrant: a transaction holding it takes it again for
 * free. The wait is the caller's lock bound (`lock_timeout`); a timeout is the caller's to map (`PAYER_JOURNAL_KEY_BUSY`).
 */
import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;

/** Mirrors `shared/journalChainHead.MAX_CHAIN_DEPTH` (a leaf cannot import it): the walk's guard against a forged loop. */
const MAX_CHAIN_DEPTH = 64;

/** What a timeout waiting for the key says: the key is held by work on the intercompany payment, which is not always a reversal. */
export const PAYER_JOURNAL_KEY_BUSY = (entryId: string) => `Journal entry ${entryId} books an intercompany payment that another request is `
  + 'working on right now (the partner clearing it, a void or a reversal) — retry in a moment.';

/** Each key in the order given (ascending bigint, as the receiver's cap lock takes them). */
export async function lockKeys(keys: Row[]): Promise<void> {
  for (const r of keys) await sql`SELECT pg_catalog.pg_advisory_xact_lock(${String(r.k)}::BIGINT)`;
}

/**
 * Take the payer's journal key of `entryId`'s chain root when an allocation message of `companyId` stands on that root; returns the root,
 * or null (no such message: no key, nothing can race). One query decides (the walk up and the question); a second takes the key.
 */
export async function lockPayerJournalKey(companyId: string, entryId: string): Promise<string | null> {
  const [hit] = (await sql`
    WITH RECURSIVE up AS (
      SELECT id, reversal_of_id, ARRAY[id] AS path FROM gl_journal_entries
       WHERE id = ${entryId}::UUID AND company_id = ${companyId}::UUID
      UNION ALL
      SELECT p.id, p.reversal_of_id, up.path || p.id FROM gl_journal_entries p
        JOIN up ON p.id = up.reversal_of_id
       WHERE p.company_id = ${companyId}::UUID AND NOT p.id = ANY(up.path) AND cardinality(up.path) < ${MAX_CHAIN_DEPTH}
    ), root AS (SELECT COALESCE((SELECT id FROM up WHERE reversal_of_id IS NULL LIMIT 1), ${entryId}::UUID) AS id)
    SELECT root.id AS root, pg_catalog.hashtextextended(${companyId}::UUID::TEXT || ':journal:' || root.id::TEXT, 1027) AS k
      FROM root
     WHERE EXISTS (SELECT 1 FROM intercompany_messages m
                    WHERE m.from_company_id = ${companyId}::UUID AND m.kind = 'allocation' AND m.source_journal_entry_id = root.id)
  `) as Row[];
  if (!hit) return null;
  await lockKeys([hit]);
  return String(hit.root);
}
