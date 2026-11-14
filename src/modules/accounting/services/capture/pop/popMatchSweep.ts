/**
 * POP inbox phase 2: attach each filed proof of payment to its debit on the company's bank lines,
 * from the mirror cron (popSweeps.ts), as the cron's role (app_service, every statement carrying its
 * company_id). Bounded: at most POP_MATCH_BATCH POPs per company per tick, least recently checked first.
 *
 * Which POPs: filed, their document not matched to a line yet, no final decision in
 * proof_of_payment_matches (migration 991), and payment_date + POP_MATCH_GIVE_UP_DAYS not passed.
 * Which lines: the company's posted lines of -amount dated payment_date .. + POP_MATCH_WINDOW_DAYS that
 * carry no proof_of_payment document yet. The name test and the uniqueness rule are popMatchRules.ts's.
 *
 * One sweep of a company at a time (a session advisory lock on its own connection; a company already
 * being swept is skipped this tick): two sweeps reading the same open POP could otherwise each act on it.
 *
 * Each attach is its own transaction: both rows are locked (line, then document, as the attach does),
 * re-read, and the attach plus its 'attached' / 'refused' row commit together. A line or document that
 * moved since the read is left for the next tick.
 */
import { getPool, sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { lockBankTransactionForUpdate } from '../../bank/bankTxLock';
import { attachCapturedDocToBankTx } from '../captureBankTxAttachService';
import { lockCapturedDocumentForUpdate } from '../captureRowLock';
import { decideMatches, type MatchPair } from './popMatchRules';

type Row = Record<string, unknown>;

export const POP_MATCH_BATCH = 200;
/** A line may be dated up to this many days after the notice's payment date. */
export const POP_MATCH_WINDOW_DAYS = 3;
/** A POP with no line is looked for again until payment_date + this many days. */
export const POP_MATCH_GIVE_UP_DAYS = 14;

const ACTOR = 'system:pop-match';

export interface PopMatchSummary {
  checked: number;
  attached: number;
  ambiguous: number;
  notFound: number;
  refused: number;
  errors: number;
}

/** Companies with at least one POP the sweep would look at. */
export async function companiesWithOpenPops(): Promise<string[]> {
  const rows = (await sql`
    SELECT DISTINCT p.company_id FROM proof_of_payments p
    JOIN captured_documents cd ON cd.id = p.captured_document_id AND cd.company_id = p.company_id
    LEFT JOIN proof_of_payment_matches m ON m.proof_of_payment_id = p.id AND m.company_id = p.company_id
    WHERE cd.matched_bank_tx_id IS NULL AND (m.id IS NULL OR m.outcome = 'not_found')
      AND p.payment_date + ${POP_MATCH_GIVE_UP_DAYS}::int >= (now() AT TIME ZONE 'Africa/Johannesburg')::date
  `) as Row[];
  return rows.map((r) => String(r.company_id));
}

const emptySummary = (): PopMatchSummary => ({ checked: 0, attached: 0, ambiguous: 0, notFound: 0, refused: 0, errors: 0 });

/** `until` (epoch ms): no POP is started after it; the rest wait for the next tick. */
export async function sweepPopMatches(companyId: string, limit: number = POP_MATCH_BATCH,
  until: number = Number.POSITIVE_INFINITY): Promise<PopMatchSummary> {
  const key = `pop_match_sweep:${companyId}`;
  const lockClient = await getPool().connect();
  let unusable = false;
  try {
    const { rows: [r] } = await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [key]);
    if (!r?.ok) {
      log.info('pop match: this company is being swept already; skipped this tick', { companyId }, 'pop-match');
      return emptySummary();
    }
    try {
      return await sweepLocked(companyId, limit, until);
    } finally {
      // A connection that keeps a session lock must not go back to the pool.
      unusable = await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).then(() => false, (err: unknown) => {
        log.error('pop match: sweep lock not released; connection dropped', { companyId, error: String(err) }, 'pop-match');
        return true;
      });
    }
  } finally {
    lockClient.release(unusable);
  }
}

async function sweepLocked(companyId: string, limit: number, until: number): Promise<PopMatchSummary> {
  const summary = emptySummary();
  const open = (await sql`
    SELECT p.id, p.captured_document_id FROM proof_of_payments p
    JOIN captured_documents cd ON cd.id = p.captured_document_id AND cd.company_id = p.company_id
    LEFT JOIN proof_of_payment_matches m ON m.proof_of_payment_id = p.id AND m.company_id = p.company_id
    WHERE p.company_id = ${companyId}::uuid AND cd.matched_bank_tx_id IS NULL
      AND (m.id IS NULL OR m.outcome = 'not_found')
      AND p.payment_date + ${POP_MATCH_GIVE_UP_DAYS}::int >= (now() AT TIME ZONE 'Africa/Johannesburg')::date
    ORDER BY m.checked_at NULLS FIRST, p.payment_date, p.id
    LIMIT ${limit}::int
  `) as Row[];
  if (open.length === 0) return summary;
  const popIds = open.map((r) => String(r.id));
  const documentOf = new Map(open.map((r) => [String(r.id), String(r.captured_document_id)]));

  // Every open POP of the company that wants one of the batch's lines is a rival for it, batch or not.
  const pairs = ((await sql`
    WITH batch AS (
      SELECT amount, payment_date FROM proof_of_payments
      WHERE company_id = ${companyId}::uuid AND id = ANY(${popIds}::uuid[])
    ), lines AS (
      SELECT DISTINCT bt.id FROM batch b
      JOIN bank_transactions bt ON bt.company_id = ${companyId}::uuid AND bt.amount = -b.amount
        AND bt.transaction_date BETWEEN b.payment_date AND b.payment_date + ${POP_MATCH_WINDOW_DAYS}::int
      WHERE bt.feed_state = 'posted'
        AND NOT EXISTS (SELECT 1 FROM captured_documents x WHERE x.company_id = bt.company_id
          AND x.matched_bank_tx_id = bt.id AND x.document_type = 'proof_of_payment')
    )
    SELECT p.id AS pop_id, p.beneficiary, bt.id AS bank_tx_id, bt.description
    FROM lines l
    JOIN bank_transactions bt ON bt.id = l.id AND bt.company_id = ${companyId}::uuid
    JOIN proof_of_payments p ON p.company_id = ${companyId}::uuid AND bt.amount = -p.amount
      AND bt.transaction_date BETWEEN p.payment_date AND p.payment_date + ${POP_MATCH_WINDOW_DAYS}::int
    JOIN captured_documents cd ON cd.id = p.captured_document_id AND cd.company_id = p.company_id
      AND cd.matched_bank_tx_id IS NULL
  `) as Row[]).map((r): MatchPair => ({
    popId: String(r.pop_id), beneficiary: String(r.beneficiary), bankTxId: String(r.bank_tx_id),
    description: r.description == null ? null : String(r.description),
  }));

  for (const [popId, decision] of decideMatches(popIds, pairs)) {
    if (Date.now() >= until) break;
    summary.checked += 1;
    try {
      if (decision.outcome === 'not_found') {
        await recordDecision(companyId, popId, 'not_found', [], null);
        summary.notFound += 1;
      } else if (decision.outcome === 'ambiguous') {
        await recordDecision(companyId, popId, 'ambiguous', decision.candidateBankTxIds, null);
        summary.ambiguous += 1;
      } else {
        const outcome = await attachOne(companyId, popId, documentOf.get(popId)!, decision.bankTxId);
        if (outcome === 'attached') summary.attached += 1;
        else if (outcome === 'refused') summary.refused += 1;
      }
    } catch (err) {
      summary.errors += 1;
      log.warn('pop match failed; retried next tick', {
        companyId, popId, error: err instanceof Error ? err.message : String(err),
      }, 'pop-match');
    }
  }
  return summary;
}

/** A final decision is never overwritten: only a 'not_found' row is updated. */
async function recordDecision(companyId: string, popId: string, outcome: 'attached' | 'ambiguous' | 'not_found' | 'refused',
  candidates: string[], refusal: string | null): Promise<void> {
  await sql`
    INSERT INTO proof_of_payment_matches (company_id, proof_of_payment_id, outcome, candidate_bank_tx_ids, refusal)
    VALUES (${companyId}::uuid, ${popId}::uuid, ${outcome}, ${candidates}::uuid[], ${refusal})
    ON CONFLICT ON CONSTRAINT proof_of_payment_matches_one_per_pop DO UPDATE
      SET outcome = EXCLUDED.outcome, candidate_bank_tx_ids = EXCLUDED.candidate_bank_tx_ids,
          refusal = EXCLUDED.refusal, checked_at = now()
      WHERE proof_of_payment_matches.outcome = 'not_found'
  `;
}

async function attachOne(companyId: string, popId: string, documentId: string, bankTxId: string): Promise<'attached' | 'refused' | 'moved'> {
  return withAlsTransaction({ userId: ACTOR, companyId }, async () => {
    if (!(await lockBankTransactionForUpdate(companyId, bankTxId))) return 'moved';
    await lockCapturedDocumentForUpdate(companyId, documentId);
    const [still] = (await sql`
      SELECT (SELECT matched_bank_tx_id IS NULL FROM captured_documents
                WHERE id = ${documentId}::uuid AND company_id = ${companyId}::uuid) AS doc_open,
             NOT EXISTS (SELECT 1 FROM captured_documents WHERE company_id = ${companyId}::uuid
                AND matched_bank_tx_id = ${bankTxId}::uuid AND document_type = 'proof_of_payment') AS line_open
    `) as Row[];
    if (!still?.doc_open || !still.line_open) {
      log.info('pop match: line or document moved since the read; left for the next tick', { companyId, popId, bankTxId }, 'pop-match');
      return 'moved';
    }
    const result = await attachCapturedDocToBankTx(companyId, documentId, bankTxId, null);
    if (result.ok) {
      await recordDecision(companyId, popId, 'attached', [bankTxId], null);
      log.info('pop attached to its bank line', { companyId, popId, bankTxId, mirrored: result.mirrored }, 'pop-match');
      return 'attached';
    }
    await recordDecision(companyId, popId, 'refused', [bankTxId], result.reason);
    log.warn('pop match: the attach refused; left for a person', { companyId, popId, bankTxId, reason: result.reason }, 'pop-match');
    return 'refused';
  });
}
