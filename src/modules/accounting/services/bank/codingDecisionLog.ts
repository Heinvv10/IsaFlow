/**
 * Coding decision log — the only writer of `categorization_decisions` (migration 903).
 *
 * One row per suggestion ISAFlow makes on a bank line, then its outcome:
 *   recordSuggestionsShown   rule / pattern / historical / llm / supplier_rule suggestion written -> pending
 *   recordAllocationDecision a person allocated the line: accepted (the suggested target) or recoded
 *   recordExcluded           a person excluded a line that still had a pending suggestion -> rejected
 *   recordAutoPosted         ISAFlow posted the line with no click (rule auto-post, gate sweep) -> accepted, auto
 *   recordAutoPostUndone     an auto-posted line was undone (run undo, or a person's reverse / unmatch) -> undone
 *   recordHandCorrected      a person marked an auto-posted line corrected by hand -> recoded
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
import { decideAllocationOutcome, type SuggestionSource } from './codingDecisionOutcome';

export type { SuggestionSource } from './codingDecisionOutcome';

const SAVEPOINT = 'coding_decision_log';

export interface ShownSuggestion {
  txId: string;
  source: SuggestionSource;
  glAccountId: string | null;
  /** The supplier or customer a rule suggested (no GL account on a contact-only rule). */
  contactId?: string | null;
  category?: string | null;
  confidence?: number | null;
}

export interface FinalChoice {
  glAccountId: string | null;
  contactId: string | null;
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
                ${entries.map((e) => e.category ?? null)}::TEXT[], ${entries.map((e) => clampConfidence(e.confidence))}::NUMERIC[])
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
    const rows = (await sql`
      SELECT id, suggested_gl_account_id, suggested_contact_id FROM categorization_decisions
      WHERE company_id = ${companyId}::UUID AND bank_transaction_id = ${txId}::UUID AND outcome = 'pending'
    `) as Array<{ id: string; suggested_gl_account_id: string | null; suggested_contact_id: string | null }>;
    const pending = rows[0];
    if (!pending) return;
    const outcome = decideAllocationOutcome(
      { glAccountId: pending.suggested_gl_account_id, contactId: pending.suggested_contact_id }, final);
    await sql`
      UPDATE categorization_decisions
      SET outcome = ${outcome}, final_gl_account_id = ${final.glAccountId}::UUID,
          final_contact_id = ${final.contactId}::UUID, decided_by = ${userId}, decided_at = now()
      WHERE id = ${pending.id}::UUID AND company_id = ${companyId}::UUID AND outcome = 'pending'
    `;
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
 * ISAFlow posted the line with no human click. The line's pending row (if any) becomes the auto-posted
 * decision — its target set to what was posted, its source kept when the posted target is the one it
 * suggested — otherwise a new decided row is inserted.
 */
export async function recordAutoPosted(companyId: string, posted: ShownSuggestion): Promise<void> {
  const gl = posted.glAccountId ?? null;
  const contact = posted.contactId ?? null;
  const confidence = clampConfidence(posted.confidence);
  await nonFatal('autoPosted', { companyId, txId: posted.txId }, () => sql`
    WITH upd AS (
      UPDATE categorization_decisions
      SET suggestion_source = CASE
            WHEN suggested_gl_account_id IS NOT DISTINCT FROM ${gl}::UUID
             AND suggested_contact_id IS NOT DISTINCT FROM ${contact}::UUID THEN suggestion_source
            ELSE ${posted.source} END,
          suggested_gl_account_id = ${gl}::UUID, suggested_contact_id = ${contact}::UUID,
          confidence = COALESCE(${confidence}::NUMERIC, confidence),
          was_auto_posted = true, auto_posted_at = now(), outcome = 'accepted',
          final_gl_account_id = ${gl}::UUID, final_contact_id = ${contact}::UUID,
          decided_by = NULL, decided_at = now()
      WHERE company_id = ${companyId}::UUID AND bank_transaction_id = ${posted.txId}::UUID AND outcome = 'pending'
      RETURNING id
    )
    INSERT INTO categorization_decisions
      (company_id, bank_transaction_id, suggestion_source, suggested_gl_account_id, suggested_contact_id,
       suggested_category, confidence, was_auto_posted, auto_posted_at, outcome,
       final_gl_account_id, final_contact_id, decided_by, decided_at)
    SELECT ${companyId}::UUID, ${posted.txId}::UUID, ${posted.source}, ${gl}::UUID, ${contact}::UUID,
           ${posted.category ?? null}, ${confidence}::NUMERIC, true, now(), 'accepted',
           ${gl}::UUID, ${contact}::UUID, NULL, now()
    WHERE NOT EXISTS (SELECT 1 FROM upd)
  `);
}

/** The line's latest auto-posted decision still standing as accepted, set to `outcome`. */
async function closeLatestAutoPosted(
  op: string, companyId: string, txId: string, userId: string, outcome: 'undone' | 'recoded',
): Promise<void> {
  await nonFatal(op, { companyId, txId }, () => sql`
    UPDATE categorization_decisions
    SET outcome = ${outcome}, decided_by = ${userId}, decided_at = now()
    WHERE id = (
      SELECT id FROM categorization_decisions
      WHERE company_id = ${companyId}::UUID AND bank_transaction_id = ${txId}::UUID
        AND was_auto_posted AND outcome = 'accepted'
      ORDER BY auto_posted_at DESC, id DESC
      LIMIT 1
    ) AND company_id = ${companyId}::UUID
  `);
}

/** An auto-posted line was undone: the run undo, or a person reversing / unmatching it. */
export function recordAutoPostUndone(companyId: string, txId: string, userId: string): Promise<void> {
  return closeLatestAutoPosted('autoPostUndone', companyId, txId, userId, 'undone');
}

/** A person recorded that a later journal is the correction of an auto-posted line (R-079). */
export function recordHandCorrected(companyId: string, txId: string, userId: string): Promise<void> {
  return closeLatestAutoPosted('handCorrected', companyId, txId, userId, 'recoded');
}
