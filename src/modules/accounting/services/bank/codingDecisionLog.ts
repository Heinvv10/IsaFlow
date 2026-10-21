/**
 * Coding decision log — the only writer of `categorization_decisions` (migration 903).
 *
 * One row per suggestion ISAFlow makes on a bank line, then its outcome:
 *   recordSuggestionsShown   rule / pattern / historical / llm / supplier_rule suggestion written -> pending
 *   recordAllocationDecision a person allocated the line: accepted (the suggested target) or recoded
 *   recordMatchDecision      a person matched the line to a journal: judged by what that journal posts
 *   recordExcluded           a person excluded a line that still had a pending suggestion -> rejected
 *   recordAutoPosted         ISAFlow posted the line with no click (rule auto-post, gate sweep) -> accepted, auto
 *   recordAutoPostUndone     an auto-posted line was undone (run undo, or a person's reverse / unmatch) -> undone
 *   recordHandCorrected      a person marked an auto-posted line corrected by hand -> recoded
 *
 * CALLED FROM THE SERVICES, not the routes: allocateTransaction, splitAllocateTransaction, matchTransaction,
 * excludeTransaction, unmatchTransaction and reverseReconciledTransaction record their own decision, so every
 * door (the bank screen, bank-match-confirm, manual entry, the MCP tools, payment voids) is covered.
 *
 * NON-FATAL BY CONSTRUCTION. Every write runs in its own savepoint and a failure is logged and swallowed:
 * the coding the user asked for has already happened, and a metrics row must never undo it. The savepoint
 * matters inside a withAuth request — a caught SQL error otherwise leaves the request transaction aborted.
 * Outside a request (LLM residual pass, cron) withSavepoint degrades to a plain call.
 *
 * TENANT SAFETY. Every statement names `company_id` explicitly; the composite FKs refuse another tenant's
 * bank line or GL account, and under app_user the 903 policy binds the active company too.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  decideAllocationOutcome, isRuleSource, matchedTarget, type CodingTarget, type SuggestionSource,
} from './codingDecisionOutcome';

export type { SuggestionSource } from './codingDecisionOutcome';

const SAVEPOINT = 'coding_decision_log';

export interface ShownSuggestion {
  txId: string;
  source: SuggestionSource;
  glAccountId: string | null;
  /** The supplier or customer a rule suggested (no GL account on a contact-only rule). */
  contactId?: string | null;
  /** A real category label; dropped for rule sources (isRuleSource). */
  category?: string | null;
  confidence?: number | null;
}

export type FinalChoice = CodingTarget;

/**
 * An auto-post. `target: 'own'` — ISAFlow chose the target itself (a rule, the import predictor), so a
 * different open suggestion is closed as superseded and the auto-post gets its own row. `target:
 * 'suggestion'` — the gate sweep posted the line's suggested_* columns, which a person's save_selection also
 * writes: only an open suggestion naming that same target becomes the auto-accepted row. Otherwise the target
 * was a person's pick, so the open suggestion is closed as recoded by the person whose run posted it, and no
 * auto-post row claims the coding as ISAFlow's.
 */
export type AutoPosting = ShownSuggestion & { journalEntryId: string } & (
  | { target: 'own' }
  | { target: 'suggestion'; triggeredBy: string }
);

/** The line's posting as it stood BEFORE a reverse / unmatch / undo, read from the locked row. */
export interface PostingRef {
  journalEntryId?: string | null;
  matchedJournalLineId?: string | null;
  provisionalJeId?: string | null;
}

const idOrNull = (v: unknown): string | null => (v == null ? null : String(v));

export function postingRefOf(tx: { matched_journal_line_id?: unknown; provisional_je_id?: unknown }): PostingRef {
  return { matchedJournalLineId: idOrNull(tx.matched_journal_line_id), provisionalJeId: idOrNull(tx.provisional_je_id) };
}

async function nonFatal(op: string, ctx: Record<string, unknown>, fn: () => Promise<unknown>): Promise<void> {
  try {
    await withSavepoint(SAVEPOINT, fn);
  } catch (err) {
    log.error('Coding decision log write failed — the coding action itself stands',
      { op, ...ctx, error: err instanceof Error ? err.message : String(err) }, 'coding-decisions');
  }
}

/** Confidence as the column takes it: 0..1, or null when the matcher gave none. */
function clampConfidence(c: number | null | undefined): number | null {
  if (c == null || !Number.isFinite(c)) return null;
  return Math.min(1, Math.max(0, c));
}

const categoryOf = (e: ShownSuggestion): string | null => (isRuleSource(e.source) ? null : e.category ?? null);

interface PendingRow { id: string; suggested_gl_account_id: string | null; suggested_contact_id: string | null }

async function pendingOf(companyId: string, txId: string): Promise<PendingRow | undefined> {
  const rows = (await sql`
    SELECT id, suggested_gl_account_id, suggested_contact_id FROM categorization_decisions
    WHERE company_id = ${companyId}::UUID AND bank_transaction_id = ${txId}::UUID AND outcome = 'pending'
  `) as PendingRow[];
  return rows[0];
}

const suggestedOf = (p: PendingRow): CodingTarget =>
  ({ glAccountId: idOrNull(p.suggested_gl_account_id), contactId: idOrNull(p.suggested_contact_id) });

/** Closes the pending row `id` with `outcome`; decidedBy null = ISAFlow decided. */
async function closePending(
  companyId: string, id: string, outcome: 'accepted' | 'recoded', final: FinalChoice, decidedBy: string | null,
): Promise<void> {
  await sql`
    UPDATE categorization_decisions
    SET outcome = ${outcome}, final_gl_account_id = ${final.glAccountId}::UUID,
        final_contact_id = ${final.contactId}::UUID, decided_by = ${decidedBy}, decided_at = now()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND outcome = 'pending'
  `;
}

/**
 * Opens (or refreshes) the pending decision for each line a suggestion was just written to. Only lines
 * still `imported` are recorded. A line already pending keeps its row; its suggestion is replaced only when
 * the target or source changed (a later rule or LLM pass superseding an earlier hit).
 */
export async function recordSuggestionsShown(companyId: string, entries: ShownSuggestion[]): Promise<void> {
  if (entries.length === 0) return;
  await nonFatal('suggestionsShown', { companyId, count: entries.length }, () => sql`
    INSERT INTO categorization_decisions
      (company_id, bank_transaction_id, suggestion_source, suggested_gl_account_id, suggested_contact_id,
       suggested_category, confidence)
    SELECT bt.company_id, bt.id, s.source, s.gl_account_id, s.contact_id, s.category, s.confidence
    FROM unnest(${entries.map((e) => e.txId)}::UUID[], ${entries.map((e) => e.source)}::TEXT[],
                ${entries.map((e) => e.glAccountId ?? null)}::UUID[], ${entries.map((e) => e.contactId ?? null)}::UUID[],
                ${entries.map(categoryOf)}::TEXT[], ${entries.map((e) => clampConfidence(e.confidence))}::NUMERIC[])
      AS s(tx_id, source, gl_account_id, contact_id, category, confidence)
    JOIN bank_transactions bt ON bt.id = s.tx_id AND bt.company_id = ${companyId}::UUID
    WHERE bt.status = 'imported' AND (s.gl_account_id IS NOT NULL OR s.contact_id IS NOT NULL)
    ON CONFLICT (company_id, bank_transaction_id) WHERE outcome = 'pending'
    DO UPDATE SET suggestion_source = EXCLUDED.suggestion_source,
                  suggested_gl_account_id = EXCLUDED.suggested_gl_account_id,
                  suggested_contact_id = EXCLUDED.suggested_contact_id,
                  suggested_category = EXCLUDED.suggested_category,
                  confidence = EXCLUDED.confidence,
                  suggested_at = now()
    WHERE (categorization_decisions.suggestion_source, categorization_decisions.suggested_gl_account_id,
           categorization_decisions.suggested_contact_id)
      IS DISTINCT FROM (EXCLUDED.suggestion_source, EXCLUDED.suggested_gl_account_id, EXCLUDED.suggested_contact_id)
  `);
}

/** A person allocated the line. Closes its pending decision as accepted or recoded; no pending row, no write. */
export async function recordAllocationDecision(
  companyId: string, txId: string, userId: string, final: FinalChoice,
): Promise<void> {
  await nonFatal('allocation', { companyId, txId }, async () => {
    const pending = await pendingOf(companyId, txId);
    if (!pending) return;
    await closePending(companyId, pending.id, decideAllocationOutcome(suggestedOf(pending), final), final, userId);
  });
}

/**
 * A person matched the line to an existing journal line. The coding is that journal's: its other lines'
 * GL accounts, and the supplier / customer of the payment it records — so a match to a journal that posts
 * the suggested account is an accepted suggestion, not a recode.
 */
export async function recordMatchDecision(
  companyId: string, txId: string, userId: string, journalLineId: string,
): Promise<void> {
  await nonFatal('match', { companyId, txId }, async () => {
    const pending = await pendingOf(companyId, txId);
    if (!pending) return;
    const [row] = (await sql`
      WITH je AS (
        SELECT journal_entry_id FROM gl_journal_lines
        WHERE id = ${journalLineId}::UUID AND company_id = ${companyId}::UUID
      )
      SELECT
        ARRAY(SELECT DISTINCT l.gl_account_id::TEXT FROM gl_journal_lines l JOIN je ON l.journal_entry_id = je.journal_entry_id
              WHERE l.company_id = ${companyId}::UUID AND l.id <> ${journalLineId}::UUID) AS gl_ids,
        ARRAY(SELECT sp.supplier_id::TEXT FROM supplier_payments sp JOIN je ON sp.gl_journal_entry_id = je.journal_entry_id
              WHERE sp.company_id = ${companyId}::UUID AND sp.supplier_id IS NOT NULL
              UNION
              SELECT cp.client_id::TEXT FROM customer_payments cp JOIN je ON cp.gl_journal_entry_id = je.journal_entry_id
              WHERE cp.company_id = ${companyId}::UUID AND cp.client_id IS NOT NULL) AS contact_ids
    `) as Array<{ gl_ids: string[] | null; contact_ids: string[] | null }>;
    const suggested = suggestedOf(pending);
    const final = matchedTarget(suggested, row?.gl_ids ?? [], row?.contact_ids ?? []);
    await closePending(companyId, pending.id, decideAllocationOutcome(suggested, final), final, userId);
  });
}

/** A person excluded the line while ISAFlow's suggestion was still open. */
export async function recordExcluded(companyId: string, txId: string, userId: string): Promise<void> {
  await nonFatal('excluded', { companyId, txId }, () => sql`
    UPDATE categorization_decisions
    SET outcome = 'rejected', decided_by = ${userId}, decided_at = now()
    WHERE company_id = ${companyId}::UUID AND bank_transaction_id = ${txId}::UUID AND outcome = 'pending'
  `);
}

/**
 * ISAFlow posted the line with no human click (see AutoPosting for `target`). An open suggestion naming
 * the posted target becomes the auto-posted decision, its suggestion untouched. Any other open suggestion is
 * closed as recoded — never rewritten into the posted target.
 */
export async function recordAutoPosted(companyId: string, posted: AutoPosting): Promise<void> {
  const final: FinalChoice = { glAccountId: posted.glAccountId ?? null, contactId: posted.contactId ?? null };
  const confidence = clampConfidence(posted.confidence);
  await nonFatal('autoPosted', { companyId, txId: posted.txId }, async () => {
    const pending = await pendingOf(companyId, posted.txId);
    if (pending && decideAllocationOutcome(suggestedOf(pending), final) === 'accepted') {
      await sql`
        UPDATE categorization_decisions
        SET was_auto_posted = true, auto_posted_at = now(), posted_journal_entry_id = ${posted.journalEntryId}::UUID,
            outcome = 'accepted', final_gl_account_id = ${final.glAccountId}::UUID,
            final_contact_id = ${final.contactId}::UUID, confidence = COALESCE(confidence, ${confidence}::NUMERIC),
            decided_by = NULL, decided_at = now()
        WHERE id = ${pending.id}::UUID AND company_id = ${companyId}::UUID AND outcome = 'pending'
      `;
      return;
    }
    const isPersonsPick = posted.target === 'suggestion';
    if (pending) await closePending(companyId, pending.id, 'recoded', final, isPersonsPick ? posted.triggeredBy : null);
    if (isPersonsPick) return;
    await sql`
      INSERT INTO categorization_decisions
        (company_id, bank_transaction_id, suggestion_source, suggested_gl_account_id, suggested_contact_id,
         suggested_category, confidence, was_auto_posted, auto_posted_at, posted_journal_entry_id, outcome,
         final_gl_account_id, final_contact_id, decided_by, decided_at)
      VALUES (${companyId}::UUID, ${posted.txId}::UUID, ${posted.source}, ${final.glAccountId}::UUID,
              ${final.contactId}::UUID, ${categoryOf(posted)}, ${confidence}::NUMERIC, true, now(),
              ${posted.journalEntryId}::UUID, 'accepted', ${final.glAccountId}::UUID, ${final.contactId}::UUID,
              NULL, now())
    `;
  });
}

/**
 * The line's auto-posted decision, still accepted, set to `outcome` — but only while the journal it posted
 * is the line's posting as `before` captured it. An auto-post an earlier, unlogged path already took off
 * the books stays as it is rather than being blamed on today's unrelated reverse.
 */
async function closeAutoPosted(
  op: string, companyId: string, txId: string, userId: string, outcome: 'undone' | 'recoded', before: PostingRef,
): Promise<void> {
  const je = before.journalEntryId ?? null;
  const line = before.matchedJournalLineId ?? null;
  const provisional = before.provisionalJeId ?? null;
  if (!je && !line && !provisional) return;
  await nonFatal(op, { companyId, txId }, () => sql`
    UPDATE categorization_decisions
    SET outcome = ${outcome}, decided_by = ${userId}, decided_at = now()
    WHERE company_id = ${companyId}::UUID AND bank_transaction_id = ${txId}::UUID
      AND was_auto_posted AND outcome = 'accepted'
      AND posted_journal_entry_id IN (
        SELECT ${je}::UUID
        UNION ALL SELECT ${provisional}::UUID
        UNION ALL SELECT jl.journal_entry_id FROM gl_journal_lines jl
                  WHERE jl.id = ${line}::UUID AND jl.company_id = ${companyId}::UUID
      )
  `);
}

/** An auto-posted line was undone: the run undo, or a person reversing / unmatching it. */
export function recordAutoPostUndone(companyId: string, txId: string, userId: string, before: PostingRef): Promise<void> {
  return closeAutoPosted('autoPostUndone', companyId, txId, userId, 'undone', before);
}

/** A person recorded that a later journal is the correction of an auto-posted line (R-079). */
export function recordHandCorrected(companyId: string, txId: string, userId: string, before: PostingRef): Promise<void> {
  return closeAutoPosted('handCorrected', companyId, txId, userId, 'recoded', before);
}
