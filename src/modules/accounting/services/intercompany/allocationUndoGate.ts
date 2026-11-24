/**
 * The PAYER's undo gate (intercompany P4-E, plan (j).4). Once the RECEIVER accepted an allocation message (P4-D cleared its invoice against its
 * loan account), the payer may not take its side back on its own: an unapply, a void (the action route, MCP `void_payment`, the undo-share
 * void) or a journal reversal of the payment's journal is refused with a plain sentence, before any write. Until reversals follow across the
 * pair (#1772 / P5), turning the flag on for a company requires this gate. A message still pending is not a reason: a void then makes it not
 * live (C's definer), so the receiver can no longer accept it.
 *
 * RACE: the receiver's accept holds the payer's transaction advisory keys (1027 `intercompany_allocation_cap_lock`:
 * hashtextextended('<payer>:payment|journal|bill:<id>', 1027)) from before its liveness check until its commit. The gate takes the SAME keys,
 * ascending, before it reads, so an accept in flight is waited for (and then seen accepted), and an accept that comes after waits for the undo
 * and then finds the payment voided. Only when the payment has an allocation message at all (a payment without one has nothing to race).
 * The keys wait under the caller's lock bound. Accepted limit: even after the receiver cancels its clearing receipt the message stays accepted,
 * so the payer's undo stays refused until intercompany reversals exist (#1772).
 *
 * UNAPPLY (fix round 1, A) is stricter than void: a payment that credited the loan account (an allocation message with cashLegIsLoanAccount)
 * is never unapplied, whatever its message's status. An unapply moves only the subledger: the clearing journal (AP debited, the loan credited)
 * would stand, the message would die (allocation_gone), the bill would reopen and could be cleared again (the loan credited twice). VOID is the
 * undo (it reverses the journal). Being refused whatever a receiver does, the unapply takes no advisory key (N: so it never holds a bill row
 * while waiting for a key, the opposite of the void's key-then-bill order).
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { findJournalChainRoot } from '../shared/journalChainHead';

type Row = Record<string, unknown>;

/** Fix round 2 (MED-5): honest. The message stays accepted even after the partner cancels its clearing receipt, and this gate refuses
 *  whatever the receipt, so there is NO in-app path to undo it until intercompany reversals exist (#1772): the sentence says so. */
export const PARTNER_CLEARED_SENTENCE = 'The partner already cleared this payment against the intercompany loan (it accepted the allocation message), so it cannot be '
  + 'voided, unapplied or reversed here, and this cannot be undone in the app yet (intercompany reversals are not automated). Contact support '
  + 'to correct it. Nothing was changed.';

export const LOAN_CLEARED_UNAPPLY_SENTENCE = 'This payment cleared the bill against the intercompany loan and its allocation message was sent to the partner, so it '
  + 'cannot be unapplied (the clearing journal would stay and the bill could be cleared twice). Void the payment instead: that reverses the clearing '
  + 'and the partner can no longer clear it. Nothing was changed.';

/** Unapply (route, MCP and its dry run): the sentence when the payment has an allocation message that the receiver ACCEPTED, or one sent for a
 *  loan-account credit (any status), else null. Reads only; no lock (see the header, A and N). */
export async function loanClearedUnapplyRefusal(companyId: string, paymentId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT bool_or(m.status = 'accepted') AS accepted, bool_or((m.payload #>> '{payment,cashLegIsLoanAccount}') = 'true') AS loan
      FROM intercompany_messages m
     WHERE m.from_company_id = ${companyId}::UUID AND m.kind = 'allocation' AND (m.payload #>> '{payment,id}') = ${paymentId}::UUID::TEXT
  `) as Row[];
  if (rows[0]?.accepted === true) return PARTNER_CLEARED_SENTENCE;
  if (rows[0]?.loan === true) {
    log.info('Payer unapply refused: the payment cleared a bill against the intercompany loan', { companyId, paymentId }, 'intercompany');
    return LOAN_CLEARED_UNAPPLY_SENTENCE;
  }
  return null;
}

/** Each key in the order the SQL sorted it (ascending bigint), as the receiver's cap lock takes them. */
async function lockKeys(keys: Row[]): Promise<void> {
  for (const r of keys) await sql`SELECT pg_catalog.pg_advisory_xact_lock(${String(r.k)}::BIGINT)`;
}

/** The sentence when a receiver accepted an allocation message of this payment of the company (the payer), else null. Takes the keys first. */
export async function partnerClearedRefusal(companyId: string, paymentId: string): Promise<string | null> {
  const any = (await sql`
    SELECT 1 AS one FROM intercompany_messages m
     WHERE m.from_company_id = ${companyId}::UUID AND m.kind = 'allocation' AND (m.payload #>> '{payment,id}') = ${paymentId}::UUID::TEXT
     LIMIT 1
  `) as Row[];
  if (any.length === 0) return null;
  // exactly the keys the receiver's clearing of each of these messages takes (1027 intercompany_allocation_cap_lock)
  const keys = (await sql`
    SELECT DISTINCT pg_catalog.hashtextextended(m.from_company_id::TEXT || x.part, 1027) AS k
      FROM intercompany_messages m
     CROSS JOIN LATERAL (VALUES (':payment:' || COALESCE(m.payload #>> '{payment,id}', '')),
                                (':journal:' || COALESCE(m.source_journal_entry_id::TEXT, '')),
                                (':bill:' || COALESCE(m.payload #>> '{payerDocument,id}', ''))) AS x(part)
     WHERE m.from_company_id = ${companyId}::UUID AND m.kind = 'allocation' AND (m.payload #>> '{payment,id}') = ${paymentId}::UUID::TEXT
     ORDER BY k
  `) as Row[];
  await lockKeys(keys);
  const accepted = (await sql`
    SELECT 1 AS one FROM intercompany_messages m
     WHERE m.from_company_id = ${companyId}::UUID AND m.kind = 'allocation' AND m.status = 'accepted'
       AND ((m.payload #>> '{payment,id}') = ${paymentId}::UUID::TEXT
         OR m.source_doc_id IN (SELECT pa.id FROM payment_allocations pa
                                  JOIN supplier_payments sp ON sp.id = pa.payment_id AND sp.company_id = ${companyId}::UUID
                                 WHERE pa.payment_id = ${paymentId}::UUID))
     LIMIT 1
  `) as Row[];
  if (accepted.length === 0) return null;
  log.info('Payer undo refused: the partner already cleared this payment', { companyId, paymentId }, 'intercompany');
  return PARTNER_CLEARED_SENTENCE;
}

/**
 * The payer's journal key (1027's cap-lock key on the entry's chain ROOT), taken by `claimJournalReversal` BEFORE its claim row lock (fix
 * round 2, LOW-1): a payer void takes its keys (payment, journal, bill) and only then the journal row (the reversal claim of its chain), so a
 * GL reversal that took the row first and the key second could deadlock with it (40P01, a 500). Same order now: key, then row. Returns the
 * root, or null when this company sent no allocation message (nothing can race: no key). Re-entrant: the refusal below takes it again.
 */
export async function lockPayerJournalKey(companyId: string, entryId: string): Promise<string | null> {
  // the cheap question first: a company that sent no allocation message walks no chain
  const any = (await sql`
    SELECT 1 AS one FROM intercompany_messages WHERE from_company_id = ${companyId}::UUID AND kind = 'allocation' LIMIT 1
  `) as Row[];
  if (any.length === 0) return null;
  const root = (await findJournalChainRoot(companyId, entryId)) ?? entryId;
  await lockKeys((await sql`SELECT pg_catalog.hashtextextended(${companyId}::UUID::TEXT || ':journal:' || ${root}::UUID::TEXT, 1027) AS k`) as Row[]);
  return root;
}

/** A journal reversal (called by `reverseJournalEntry` for every entry, under its claim, before any write): refused when the entry, or the
 *  entry its chain starts from, is the journal an ACCEPTED allocation message of this company (the payer) stands on. */
export async function partnerClearedJournalRefusal(companyId: string, entryId: string): Promise<string | null> {
  const root = await lockPayerJournalKey(companyId, entryId);
  if (root === null) return null;
  const accepted = (await sql`
    SELECT 1 AS one FROM intercompany_messages
     WHERE from_company_id = ${companyId}::UUID AND kind = 'allocation' AND status = 'accepted' AND source_journal_entry_id = ${root}::UUID
     LIMIT 1
  `) as Row[];
  return accepted.length > 0 ? PARTNER_CLEARED_SENTENCE : null;
}
