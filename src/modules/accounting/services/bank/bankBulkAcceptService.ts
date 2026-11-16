/**
 * Bulk accept of high-confidence suggestions, the WRITE half (audit WP6, Hein decision 2a.2): confirm a preview in ONE
 * request, and undo exactly that batch.
 *
 * REUSES THE AUTO-POST RUN MACHINERY. A confirm creates a `bank_auto_post_runs` row (source 'manual', which the CHECK
 * already allows) and tags every posted line with `auto_post_run_id`; the batch undo is `undoRun`, so it reverses
 * exactly that run's journals, restores each line, skips a reconciled one (reported) and is safe to repeat.
 *
 * EVERY GUARD THE SINGLE ACCEPT RUNS, BY CONSTRUCTION: each line is posted through `allocateTransaction` (the
 * allocate action's own service), so the hand-keyed gates, the importer check, VAT/period/dimension refusals, the
 * refund gate and later guards all apply with no copy here. The unattended VAT guards the gate sweep runs
 * (`resolveRuleVatCode`: s17(2)(a) denial, no-supply accounts) run too, since nobody reviews each line's VAT.
 *
 * One line, one savepoint, decided by OUTCOME: under its row lock a line is refused when it changed since the preview
 * (status, suggestion or version), when the gate no longer passes it, or when posting it raises; the rest still post.
 * Lines are taken in id order (a total lock order), under one advisory lock per company + bank account, so a second
 * confirm for the account fails fast (409) instead of queueing every line behind the first request's row locks.
 * Transfer-pair locks (row 5) are not taken here: allocateTransaction's own locking applies.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { allocateTransaction } from './bankAllocationService';
import { resolveRuleVatCode } from '../gl/ruleVatResolution';
import { evaluate } from './autoPostGate';
import { getAutoPostSettings } from './autoPostSettingsService';
import { feedStateOf } from './bankFeedStateGuard';
import { lockBankTransactionForUpdate } from './bankTxLock';
import { assertBankAccountInCompany } from './bankAccountGuard';
import { BankControlError } from './bankControlRefusal';
import { undoRun } from './autoPostUndoService';
import { BulkAcceptRefusal, bulkAcceptSettings, readPreviewToken, type TokenLine } from './bankBulkAcceptPreview';

const LINE_SAVEPOINT = 'bulk_accept_line';

export interface BulkAcceptResult {
  runId: string | null;
  posted: Array<{ txId: string; journalEntryId: string }>;
  refused: Array<{ txId: string; reason: string }>;
  totalPosted: number;
}

class LineRefused extends Error {}

export async function confirmBulkAccept(companyId: string, userId: string, previewToken: unknown): Promise<BulkAcceptResult> {
  const token = readPreviewToken(previewToken);
  await assertBankAccountInCompany(companyId, token.a);
  const [lock] = (await sql`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${`bulk-accept:${companyId}:${token.a}`}, 0)) AS ok`) as Array<{ ok: boolean }>;
  if (!lock?.ok) throw new BulkAcceptRefusal('Another bulk accept is running for this bank account. Wait for it, then preview again.', 409);

  const base = await getAutoPostSettings(companyId);
  const settings = bulkAcceptSettings(base, token.t);
  const lines = [...token.l].sort((a, b) => a.i.localeCompare(b.i));
  const result: BulkAcceptResult = { runId: null, posted: [], refused: [], totalPosted: 0 };
  let runId: string | null = null;

  for (const line of lines) {
    const runBefore: string | null = runId;
    try {
      const journalEntryId = await withSavepoint(LINE_SAVEPOINT, async () => {
        const row = await lockBankTransactionForUpdate(companyId, line.i);
        const changed = await changedSincePreview(companyId, line, row);
        if (changed) throw new LineRefused(changed);
        const gate = evaluate({ status: String(row!.status), amount: Number(row!.amount), suggestedGlAccountId: line.g },
          Number(row!.suggested_confidence), settings, row!.suggested_strategy == null ? null : String(row!.suggested_strategy));
        if (gate.outcome === 'skip') throw new LineRefused(`not eligible any more: ${gate.reason}`);
        if (String(row!.bank_account_id) !== token.a) throw new LineRefused('the line is not on the previewed bank account');
        const guarded = await resolveRuleVatCode({
          allocType: 'account', companyId, requestedVatCode: line.x ?? 'none', glAccountId: line.g,
          denialContext: { bankTxId: line.i, source: 'bulk_accept' }, guardContext: { bankTxId: line.i, ruleName: 'bulk accept' },
        });
        const vat = guarded.denied || guarded.nonSupplyCoerced ? guarded.vatCode : (line.x ?? undefined);
        const allocated = await allocateTransaction(companyId, line.i, line.g, userId,
          row!.description == null ? undefined : String(row!.description), 'account', undefined, vat);
        if (runId === null) {
          const created = (await sql`
            INSERT INTO bank_auto_post_runs (company_id, source, min_confidence, amount_cap, created_by)
            VALUES (${companyId}::UUID, 'manual', ${token.t}::NUMERIC, ${base.amountCap}::NUMERIC, ${userId}::UUID)
            RETURNING id`) as Array<{ id: string }>;
          runId = String(created[0]!.id);
        }
        await sql`UPDATE bank_transactions SET auto_post_run_id = ${runId}::UUID WHERE id = ${line.i}::UUID AND company_id = ${companyId}::UUID`;
        result.totalPosted += Math.abs(Number(row!.amount));
        return allocated.journalEntryId;
      });
      result.posted.push({ txId: line.i, journalEntryId });
    } catch (err) {
      runId = runBefore; // the savepoint took the run row back if this line minted it
      if (!(err instanceof LineRefused)) log.warn('Bulk accept refused a line', { companyId, txId: line.i, error: err }, 'bank-bulk-accept');
      result.refused.push({ txId: line.i, reason: refusalReason(err) });
    }
  }
  if (runId !== null) {
    await sql`
      UPDATE bank_auto_post_runs SET posted_count = ${result.posted.length}, total_amount = ${result.totalPosted}::NUMERIC
      WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID`;
  }
  result.runId = runId;
  log.info('Bulk accept confirmed', { companyId, runId, posted: result.posted.length, refused: result.refused.length }, 'bank-bulk-accept');
  return result;
}

const refusalReason = (err: unknown): string => err instanceof BankControlError ? `approval_required: ${err.message}`
  : err instanceof Error ? err.message : String(err);

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
  return undoRun(companyId, runId, userId);
}
