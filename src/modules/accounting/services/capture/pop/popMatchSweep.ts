/**
 * POP inbox phase 2: attach each filed proof of payment to its debit on the company's bank lines,
 * from the mirror cron (popSweeps.ts), as the cron's role (app_service, every statement carrying its
 * company_id). Bounded: at most POP_MATCH_BATCH POPs per company per tick, least recently checked first,
 * and no POP is started after the caller's deadline.
 *
 * Which POPs: filed, their document not matched to a line yet, no final decision in
 * proof_of_payment_matches (migration 991), and payment_date + POP_MATCH_GIVE_UP_DAYS not passed (SAST,
 * read once per sweep from the database: sastToday).
 * Which lines: the company's posted lines of -amount dated payment_date .. + POP_MATCH_WINDOW_DAYS that
 * carry no proof_of_payment document yet. The name test and the decision rules are popMatchRules.ts's.
 *
 * One sweep of a company at a time (a session advisory lock on its own connection; a company already
 * being swept is skipped this tick): two sweeps reading the same open POP could otherwise each act on it.
 *
 * Each attach is its own transaction: both rows are locked (line, then document, as the attach does),
 * re-read (stillUniqueUnderLock), and the attach plus its 'attached' / 'refused' row commit together; if that row cannot be
 * written (a final decision is already there) the attach rolls back. A line or document that moved since
 * the read is counted `moved` and left for the next tick.
 */
import { getPool, sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { lockBankTransactionForUpdate } from '../../bank/bankTxLock';
import { attachCapturedDocToBankTx } from '../captureBankTxAttachService';
import { lockCapturedDocumentForUpdate } from '../captureRowLock';
import { decideMatches, descriptionNamesBeneficiary, type MatchPair } from './popMatchRules';

type Row = Record<string, unknown>;
type Outcome = 'attached' | 'ambiguous' | 'not_found' | 'refused';

export const POP_MATCH_BATCH = 200;
/** A line may be dated up to this many days after the notice's payment date. */
export const POP_MATCH_WINDOW_DAYS = 3;
/** A POP with no line is looked for again until payment_date + this many days (statement imports lag weeks). */
export const POP_MATCH_GIVE_UP_DAYS = 45;

const ACTOR = 'system:pop-match';

export interface PopMatchSummary {
  checked: number;
  attached: number;
  ambiguous: number;
  notFound: number;
  refused: number;
  moved: number;
  errors: number;
}

export const emptyMatchSummary = (): PopMatchSummary =>
  ({ checked: 0, attached: 0, ambiguous: 0, notFound: 0, refused: 0, moved: 0, errors: 0 });

/** Today in South Africa, from the database clock: every date rule of the sweep compares against it. */
async function sastToday(): Promise<string> {
  const [r] = (await sql`SELECT (now() AT TIME ZONE 'Africa/Johannesburg')::date::text AS today`) as Row[];
  return String(r!.today);
}

/** Companies with at least one POP the sweep would look at. */
export async function companiesWithOpenPops(): Promise<string[]> {
  const today = await sastToday();
  const rows = (await sql`
    SELECT DISTINCT p.company_id FROM proof_of_payments p
    JOIN captured_documents cd ON cd.id = p.captured_document_id AND cd.company_id = p.company_id
    LEFT JOIN proof_of_payment_matches m ON m.proof_of_payment_id = p.id AND m.company_id = p.company_id
    WHERE cd.matched_bank_tx_id IS NULL AND (m.id IS NULL OR m.outcome = 'not_found')
      AND p.payment_date + ${POP_MATCH_GIVE_UP_DAYS}::int >= ${today}::date
  `) as Row[];
  return rows.map((r) => String(r.company_id));
}

/** `deadline` (epoch ms): no POP is started after it; the rest wait for the next tick. */
export async function sweepPopMatches(companyId: string, limit: number = POP_MATCH_BATCH,
  deadline: number = Number.POSITIVE_INFINITY): Promise<PopMatchSummary> {
  const key = `pop_match_sweep:${companyId}`;
  const lockClient = await getPool().connect();
  let unlockFailed: unknown;
  try {
    const { rows: [r] } = await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [key]);
    if (!r?.ok) {
      log.info('pop match: this company is being swept already; skipped this tick', { companyId }, 'pop-match');
      return emptyMatchSummary();
    }
    try {
      return await sweepLocked(companyId, limit, deadline);
    } finally {
      try {
        await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      } catch (err) {
        // A connection that keeps a session lock must not go back to the pool: released with the error, it is destroyed.
        unlockFailed = err;
        log.error('pop match: sweep lock not released; connection dropped', { companyId, error: String(err) }, 'pop-match');
      }
    }
  } finally {
    lockClient.release(unlockFailed instanceof Error ? unlockFailed : unlockFailed !== undefined);
  }
}

async function sweepLocked(companyId: string, limit: number, deadline: number): Promise<PopMatchSummary> {
  const summary = emptyMatchSummary();
  const today = await sastToday();
  const open = (await sql`
    SELECT p.id, p.captured_document_id FROM proof_of_payments p
    JOIN captured_documents cd ON cd.id = p.captured_document_id AND cd.company_id = p.company_id
    LEFT JOIN proof_of_payment_matches m ON m.proof_of_payment_id = p.id AND m.company_id = p.company_id
    WHERE p.company_id = ${companyId}::uuid AND cd.matched_bank_tx_id IS NULL
      AND (m.id IS NULL OR m.outcome = 'not_found')
      AND p.payment_date + ${POP_MATCH_GIVE_UP_DAYS}::int >= ${today}::date
    ORDER BY m.checked_at NULLS FIRST, p.payment_date, p.id
    LIMIT ${limit}::int
  `) as Row[];
  if (open.length === 0) return summary;
  const popIds = open.map((r) => String(r.id));
  const documentOf = new Map(open.map((r) => [String(r.id), String(r.captured_document_id)]));
  const pairs = await candidatePairs(companyId, popIds, today);

  for (const [popId, decision] of decideMatches(popIds, pairs)) {
    if (Date.now() >= deadline) break;
    summary.checked += 1;
    try {
      if (decision.outcome === 'not_found') {
        await recordDecision(companyId, popId, 'not_found', [], null);
        summary.notFound += 1;
      } else if (decision.outcome === 'ambiguous') {
        await recordDecision(companyId, popId, 'ambiguous', decision.candidateBankTxIds, null);
        summary.ambiguous += 1;
      } else {
        const outcome = await attachOne(companyId, popId, documentOf.get(popId)!, decision.bankTxId, today);
        summary[outcome === 'attached' ? 'attached' : outcome === 'refused' ? 'refused' : 'moved'] += 1;
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

/**
 * Every (open POP, free line) pair on amount and window that involves a line some batch POP wants: the batch's
 * own candidates AND every rival claim on them (any open POP of the company, whatever its decision, so an
 * 'ambiguous' POP still claims its lines). `window_imported`: the line's account has a posted line dated after
 * the window (and no later than today: a misdated future line opens nothing), so no further candidate can still
 * arrive for that account.
 */
async function candidatePairs(companyId: string, popIds: string[], today: string): Promise<MatchPair[]> {
  const rows = (await sql`
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
    SELECT p.id AS pop_id, p.beneficiary, bt.id AS bank_tx_id, bt.description,
      EXISTS (SELECT 1 FROM bank_transactions later WHERE later.company_id = bt.company_id
        AND later.bank_account_id = bt.bank_account_id AND later.feed_state = 'posted'
        AND later.transaction_date > p.payment_date + ${POP_MATCH_WINDOW_DAYS}::int
        AND later.transaction_date <= ${today}::date) AS window_imported
    FROM lines l
    JOIN bank_transactions bt ON bt.id = l.id AND bt.company_id = ${companyId}::uuid
    JOIN proof_of_payments p ON p.company_id = ${companyId}::uuid AND bt.amount = -p.amount
      AND bt.transaction_date BETWEEN p.payment_date AND p.payment_date + ${POP_MATCH_WINDOW_DAYS}::int
    JOIN captured_documents cd ON cd.id = p.captured_document_id AND cd.company_id = p.company_id
      AND cd.matched_bank_tx_id IS NULL
  `) as Row[];
  return rows.map((r): MatchPair => ({
    popId: String(r.pop_id), beneficiary: String(r.beneficiary), bankTxId: String(r.bank_tx_id),
    description: r.description == null ? null : String(r.description), windowImported: r.window_imported === true,
  }));
}

/**
 * A final decision is never overwritten: only a 'not_found' row is updated (and migration 991's trigger refuses
 * any other update). Throws when nothing was written, so an attach in the same transaction rolls back.
 */
async function recordDecision(companyId: string, popId: string, outcome: Outcome, candidates: string[], refusal: string | null): Promise<void> {
  const written = (await sql`
    INSERT INTO proof_of_payment_matches (company_id, proof_of_payment_id, outcome, candidate_bank_tx_ids, refusal)
    VALUES (${companyId}::uuid, ${popId}::uuid, ${outcome}, ${candidates}::uuid[], ${refusal})
    ON CONFLICT ON CONSTRAINT proof_of_payment_matches_one_per_pop DO UPDATE
      SET outcome = EXCLUDED.outcome, candidate_bank_tx_ids = EXCLUDED.candidate_bank_tx_ids,
          refusal = EXCLUDED.refusal, checked_at = now()
      WHERE proof_of_payment_matches.outcome = 'not_found'
    RETURNING id
  `) as Row[];
  if (written.length === 0) throw new Error(`pop match: POP ${popId} already has a final decision; ${outcome} not recorded`);
}

/**
 * Re-read under both locks, by the same rules as the sweep's read: the document is still unmatched; this POP's own
 * candidates (posted, free, of -amount, in the window, naming the beneficiary) are still exactly this one line; its
 * account is still imported past the window; and no open POP of the company OTHER than this one (one filed after
 * the pairs were read included) also names it. Anything else: the next tick decides.
 */
async function stillUniqueUnderLock(companyId: string, popId: string, documentId: string, bankTxId: string, today: string): Promise<boolean> {
  const [r] = (await sql`
    SELECT p.beneficiary,
      (SELECT matched_bank_tx_id IS NULL FROM captured_documents
        WHERE id = ${documentId}::uuid AND company_id = ${companyId}::uuid) AS doc_open,
      (SELECT coalesce(json_agg(json_build_object('id', c.id, 'description', c.description)), '[]'::json)
        FROM bank_transactions c
        WHERE c.company_id = ${companyId}::uuid AND c.feed_state = 'posted' AND c.amount = -p.amount
          AND c.transaction_date BETWEEN p.payment_date AND p.payment_date + ${POP_MATCH_WINDOW_DAYS}::int
          AND NOT EXISTS (SELECT 1 FROM captured_documents x WHERE x.company_id = c.company_id
            AND x.matched_bank_tx_id = c.id AND x.document_type = 'proof_of_payment')) AS own_lines,
      (SELECT description FROM bank_transactions WHERE id = ${bankTxId}::uuid AND company_id = ${companyId}::uuid) AS line_description,
      EXISTS (SELECT 1 FROM bank_transactions t
        JOIN bank_transactions later ON later.company_id = t.company_id AND later.bank_account_id = t.bank_account_id
        WHERE t.id = ${bankTxId}::uuid AND t.company_id = ${companyId}::uuid AND later.feed_state = 'posted'
          AND later.transaction_date > p.payment_date + ${POP_MATCH_WINDOW_DAYS}::int
          AND later.transaction_date <= ${today}::date) AS window_imported,
      ARRAY(SELECT o.beneficiary FROM proof_of_payments o
        JOIN captured_documents ocd ON ocd.id = o.captured_document_id AND ocd.company_id = o.company_id
          AND ocd.matched_bank_tx_id IS NULL
        JOIN bank_transactions t ON t.id = ${bankTxId}::uuid AND t.company_id = ${companyId}::uuid
        WHERE o.company_id = ${companyId}::uuid AND o.id <> p.id AND t.amount = -o.amount
          AND t.transaction_date BETWEEN o.payment_date AND o.payment_date + ${POP_MATCH_WINDOW_DAYS}::int) AS rival_names
    FROM proof_of_payments p
    WHERE p.id = ${popId}::uuid AND p.company_id = ${companyId}::uuid
  `) as Row[];
  if (!r || r.doc_open !== true || r.window_imported !== true) return false;
  const beneficiary = String(r.beneficiary);
  const own = ((r.own_lines as Array<{ id: string; description: string | null }> | null) ?? [])
    .filter((l) => descriptionNamesBeneficiary(l.description, beneficiary));
  if (own.length !== 1 || own[0]!.id !== bankTxId) return false;
  const description = r.line_description == null ? null : String(r.line_description);
  return !((r.rival_names as string[] | null) ?? []).some((name) => descriptionNamesBeneficiary(description, name));
}

async function attachOne(companyId: string, popId: string, documentId: string, bankTxId: string,
  today: string): Promise<'attached' | 'refused' | 'moved'> {
  // Its own transaction; the savepoint keeps that true when a caller's transaction is already open (tests).
  return withAlsTransaction({ userId: ACTOR, companyId }, () => withSavepoint('pop_match_attach', async () => {
    if (!(await lockBankTransactionForUpdate(companyId, bankTxId))) return 'moved' as const;
    await lockCapturedDocumentForUpdate(companyId, documentId);
    if (!(await stillUniqueUnderLock(companyId, popId, documentId, bankTxId, today))) {
      log.info('pop match: line, document or rivals changed since the read; left for the next tick', { companyId, popId, bankTxId }, 'pop-match');
      return 'moved' as const;
    }
    const result = await attachCapturedDocToBankTx(companyId, documentId, bankTxId, null);
    if (result.ok) {
      await recordDecision(companyId, popId, 'attached', [bankTxId], null);
      log.info('pop attached to its bank line', { companyId, popId, bankTxId, mirrored: result.mirrored }, 'pop-match');
      return 'attached' as const;
    }
    await recordDecision(companyId, popId, 'refused', [bankTxId], result.reason);
    log.warn('pop match: the attach refused; left for a person', { companyId, popId, bankTxId, reason: result.reason }, 'pop-match');
    return 'refused' as const;
  }));
}
