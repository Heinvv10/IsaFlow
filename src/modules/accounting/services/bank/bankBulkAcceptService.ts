/**
 * Bulk accept of high-confidence suggestions, the WRITE half (audit WP6, Hein decision 2a.2): confirm a preview in ONE
 * request, and undo exactly that batch.
 *
 * REUSES THE AUTO-POST RUN MACHINERY. A confirm creates a `bank_auto_post_runs` row (source 'manual', which the CHECK
 * already allows) and tags every posted line with `auto_post_run_id`; the batch undo is `undoRun`, so it reverses
 * exactly that run's journals, restores each line, skips a reconciled one (reported) and is safe to repeat. Bulk accept
 * is the only creator of 'manual' runs, which is what lets the batch undo be restricted to them. The run's
 * `amount_cap` records the company's standard-tier cap; an LLM-tier line is judged against its own cap at confirm.
 *
 * EVERY GUARD THE SINGLE ACCEPT RUNS, BY CONSTRUCTION: each line is posted through `allocateTransaction` (the
 * allocate action's own service), so the hand-keyed gates, the importer check, VAT/period/dimension refusals, the
 * refund gate and later guards all apply with no copy here. The line's SAVED cc1/cc2/bu go in exactly as the single
 * accept passes them. The unattended VAT guards the gate sweep runs (`resolveRuleVatCode`) run too, since nobody
 * reviews each line's VAT. `allowLateInputClaim` stays off, as in the sweep: claiming input VAT late (s16(3)) needs a
 * person's explicit choice per line, which a batch cannot give.
 *
 * One line, one savepoint, decided by OUTCOME: under its row lock a line is refused when it changed since the preview
 * (status, suggestion or version), when the gate no longer passes it (the floor is resolved SERVER-SIDE: the token is
 * unsigned), or when posting it raises. One advisory lock per company + bank account makes a second confirm for the
 * account fail fast (409).
 *
 * LOCKS (review F2/F3): BEFORE anything posts, ALL the batch's line locks are taken in one id-ordered pass with
 * FOR UPDATE SKIP LOCKED. A line another request holds is refused at once as "busy - retry" (no 5 s wait per line), and
 * because the batch already holds every line it will post, posting never waits on a line lock while it holds the
 * journal-number lock - which is what deadlocked against a concurrent single accept. Transfer-pair locks (row 5) are not
 * taken here: allocateTransaction's own locking applies.
 *
 * UNDO under enforcement: the person who confirmed cannot undo their own batch; another admin must (the run-undo
 * control, bankReversalGate, unchanged).
 */
import { sql, withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import { refusalReason, isTypedRefusal, LineRefused, LEDGER_BUSY } from './bankBulkAcceptRefusals';
import { accountsBelongToCompany } from '../gl/chartOfAccountsService';
import { VatAccountNotFoundError } from './bankVatAccountResolver';
import { allocateTransaction } from './bankAllocationService';
import { resolveRuleVatCode } from '../gl/ruleVatResolution';
import { evaluate } from './autoPostGate';
import { getAutoPostSettings } from './autoPostSettingsService';
import { feedStateOf } from './bankFeedStateGuard';
import { lockBankTransactionForUpdate } from './bankTxLock';
import { assertBankAccountInCompany } from './bankAccountGuard';
import { undoRun, RunAlreadyUndoneError } from './autoPostUndoService';
import { BulkAcceptRefusal, bulkAcceptSettings, readPreviewToken, resolveMinConfidence, type TokenLine } from './bankBulkAcceptPreview';

const LINE_SAVEPOINT = 'bulk_accept_line';

export interface BulkAcceptResult {
  runId: string | null;
  posted: Array<{ txId: string; journalEntryId: string }>;
  refused: Array<{ txId: string; reason: string }>;
  totalPosted: number;
}

/**
 * `admit` runs after the token is valid and the account's lock is held, so a malformed token or a 409 never spends
 * the caller's rate-limit quota; when it answers false the confirm is turned away 429.
 */
export async function confirmBulkAccept(
  companyId: string, userId: string, previewToken: unknown, admit?: () => Promise<boolean>,
): Promise<BulkAcceptResult> {
  const token = readPreviewToken(previewToken);
  const accountId = token.a.toLowerCase();
  await assertBankAccountInCompany(companyId, accountId);
  const [lock] = (await sql`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${`bulk-accept:${companyId}:${accountId}`}, 0)) AS ok`) as Array<{ ok: boolean }>;
  if (!lock?.ok) throw new BulkAcceptRefusal('Another bulk accept is running for this bank account. Wait for it, then preview again.', 409);

  if (admit && !(await admit())) throw new BulkAcceptRefusal('Too many bulk accepts. Please try again shortly.', 429);

  const base = await getAutoPostSettings(companyId);
  // The floor is the server's: a forged token cannot lower it, and a non-finite one is refused (resolveMinConfidence).
  const minConfidence = resolveMinConfidence(base, token.t);
  const settings = bulkAcceptSettings(base, minConfidence);
  const lines = [...token.l].sort((a, b) => (a.i < b.i ? -1 : a.i > b.i ? 1 : 0));
  const result: BulkAcceptResult = { runId: null, posted: [], refused: [], totalPosted: 0 };
  let runId: string | null = null;
  let totalCents = 0;
  const busyYears = new Set<string>(); // years whose journal-number sequence timed out: the rest of that year would wait just as long
  const { busy, stamped } = await lockLinesUpFront(companyId, lines.map((l) => l.i));

  for (const line of lines) {
    const runBefore: string | null = runId;
    if (busyYears.has(line.d.slice(0, 4))) {
      result.refused.push({ txId: line.i, reason: LEDGER_BUSY });
      continue;
    }
    if (stamped.has(line.i.toLowerCase())) {
      // A reconciliation session took the line after the preview: refused without taking its lock (no wait).
      result.refused.push({ txId: line.i, reason: 'the line changed since the preview (a reconciliation now holds it)' });
      continue;
    }
    if (busy.has(line.i.toLowerCase())) {
      result.refused.push({ txId: line.i, reason: 'busy - retry (another request holds this line)' });
      continue;
    }
    try {
      const posted = await withSavepoint(LINE_SAVEPOINT, async () => {
        const row = await lockBankTransactionForUpdate(companyId, line.i);
        const changed = await changedSincePreview(companyId, line, row);
        if (changed) throw new LineRefused(changed);
        const gate = evaluate({ status: String(row!.status), amount: Number(row!.amount), suggestedGlAccountId: line.g },
          Number(row!.suggested_confidence), settings, row!.suggested_strategy == null ? null : String(row!.suggested_strategy));
        if (gate.outcome === 'skip') throw new LineRefused(`not eligible any more: ${gate.reason}`);
        if (Number(row!.amount) !== line.m || fmtDate(row!.transaction_date) !== line.d) throw new LineRefused('the line changed since the preview (amount or date)');
        if (String(row!.bank_account_id).toLowerCase() !== accountId) throw new LineRefused('the line is not on the previewed bank account');
        const guarded = await resolveRuleVatCode({
          allocType: 'account', companyId, requestedVatCode: line.x ?? 'none', glAccountId: line.g,
          denialContext: { bankTxId: line.i, source: 'bulk_accept' }, guardContext: { bankTxId: line.i, ruleName: 'bulk accept' },
        });
        const vat = guarded.denied || guarded.nonSupplyCoerced ? guarded.vatCode : (line.x ?? undefined);
        // The writer's own account-ownership error is a plain Error, so it is asked first and reads as the refusal it is. Its
        // dimension check throws the typed JournalDimensionValidationError (passed through as its own text); a database
        // error is untyped and reads as the generic fault with an error-level log.
        if (!(await accountsBelongToCompany(companyId, [line.g]))) throw new LineRefused('One or more journal lines name a GL account outside this company');
        const dim = (v: unknown) => (v == null ? undefined : String(v));
        const allocated = await allocateTransaction(companyId, line.i, line.g, userId,
          row!.description == null ? undefined : String(row!.description), 'account', undefined, vat,
          dim(row!.cc1_id), dim(row!.cc2_id), dim(row!.bu_id));
        if (runId === null) {
          const created = (await sql`
            INSERT INTO bank_auto_post_runs (company_id, source, min_confidence, amount_cap, created_by)
            VALUES (${companyId}::UUID, 'manual', ${minConfidence}::NUMERIC, ${base.amountCap}::NUMERIC, ${userId}::UUID)
            RETURNING id`) as Array<{ id: string }>;
          runId = String(created[0]!.id);
        }
        await sql`UPDATE bank_transactions SET auto_post_run_id = ${runId}::UUID, auto_post_journal_id = ${allocated.journalEntryId}::UUID WHERE id = ${line.i}::UUID AND company_id = ${companyId}::UUID`;
        return { journalEntryId: allocated.journalEntryId, cents: Math.round(Math.abs(Number(row!.amount)) * 100) };
      });
      totalCents += posted.cents;
      result.posted.push({ txId: line.i, journalEntryId: posted.journalEntryId });
    } catch (err) {
      if (refusalReason(err) === LEDGER_BUSY) busyYears.add(line.d.slice(0, 4)); // the number lock is per company + entry year
      runId = runBefore; // the savepoint took the run row back if this line minted it
      const reason = refusalReason(err);
      // A typed refusal is the caller's to fix (info); only an untyped error is a fault worth an error line.
      if (err instanceof VatAccountNotFoundError) log.warn('Bulk accept: the company has no VAT system account', { companyId, txId: line.i, reason }, 'bank-bulk-accept');
      else if (isTypedRefusal(err)) log.info('Bulk accept refused a line', { companyId, txId: line.i, reason }, 'bank-bulk-accept');
      else log.error('Bulk accept could not post a line', { companyId, txId: line.i, error: err }, 'bank-bulk-accept');
      result.refused.push({ txId: line.i, reason });
    }
  }
  result.totalPosted = totalCents / 100;
  if (runId !== null) {
    await sql`
      UPDATE bank_auto_post_runs SET posted_count = ${result.posted.length}, total_amount = ${result.totalPosted}::NUMERIC
      WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID`;
  }
  result.runId = runId;
  log.info('Bulk accept confirmed', { companyId, runId, posted: result.posted.length, refused: result.refused.length }, 'bank-bulk-accept');
  return result;
}

/**
 * Lock every line of the batch, in id order, skipping (not waiting for) any a peer holds: the ids returned are the ones
 * that are BUSY, and the ones a reconciliation session now stamps (never locked here: the session's share lock comes before
 * the line in the lock order, so the line is refused at once as changed since the preview, not waited for).
 */
async function lockLinesUpFront(companyId: string, ids: string[]): Promise<{ busy: Set<string>; stamped: Set<string> }> {
  const locked = (await sql`
    SELECT id::TEXT AS id FROM bank_transactions
    WHERE id = ANY(${ids}::UUID[]) AND company_id = ${companyId}::UUID AND reconciliation_id IS NULL
    ORDER BY id FOR UPDATE SKIP LOCKED`) as Array<{ id: string }>;
  const got = new Set(locked.map((r) => r.id.toLowerCase()));
  const missing = ids.filter((id) => !got.has(id.toLowerCase()));
  const busy = new Set<string>();
  const stamped = new Set<string>();
  if (missing.length === 0) return { busy, stamped };
  const rest = (await sql`
    SELECT id::TEXT AS id, reconciliation_id IS NOT NULL AS stamped FROM bank_transactions
    WHERE id = ANY(${missing}::UUID[]) AND company_id = ${companyId}::UUID`) as Array<{ id: string; stamped: boolean }>;
  for (const r of rest) (r.stamped ? stamped : busy).add(r.id.toLowerCase()); // exist and not lockable now: stamped, or busy
  return { busy, stamped };
}

/** Why the locked line is no longer the one previewed, or null when it is. */
async function changedSincePreview(companyId: string, line: TokenLine, row: Awaited<ReturnType<typeof lockBankTransactionForUpdate>>): Promise<string | null> {
  if (!row) return 'the line no longer exists';
  if (String(row.status) !== 'imported') return `the line changed since the preview (it is now ${String(row.status)})`;
  if (feedStateOf(row) !== 'posted') return `the line changed since the preview (feed state ${feedStateOf(row)})`;
  const [v] = (await sql`
    SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS version FROM bank_transactions
    WHERE id = ${line.i}::UUID AND company_id = ${companyId}::UUID`) as Array<{ version: string }>;
  const sameSuggestion = String(row.suggested_gl_account_id ?? '') === line.g.toLowerCase()
    && (row.suggested_vat_code == null ? null : String(row.suggested_vat_code)) === line.x;
  if (!sameSuggestion || v?.version !== line.s) return 'the line changed since the preview';
  return null;
}

/** Undo exactly one bulk-accept batch (a 'manual' run): `undoRun`, after checking the run is one. */
export async function undoBulkAcceptBatch(companyId: string, runId: string, userId: string) {
  const [run] = (await sql`
    SELECT source, undone_at FROM bank_auto_post_runs WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID`) as Array<{ source: string; undone_at: unknown }>;
  if (!run) throw new BulkAcceptRefusal(`Batch ${runId} not found`, 404);
  if (run.undone_at) throw new BulkAcceptRefusal('That batch is already undone.');
  if (run.source !== 'manual') throw new BulkAcceptRefusal('That run is not a bulk-accept batch. Undo it from the auto-post runs panel.');
  try {
    return await undoRun(companyId, runId, userId);
  } catch (err) {
    // A concurrent undo finished the run between the check above and undoRun's own: the same refusal, typed.
    if (err instanceof RunAlreadyUndoneError) throw new BulkAcceptRefusal('That batch is already undone.');
    throw err;
  }
}
