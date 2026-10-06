/**
 * Auto-Post Gate Service
 * Single eligibility authority for silent bank-transaction JE auto-posting.
 * Mirrors the capture-side autoPublishGateService decision-ladder shape.
 *
 * evaluate() is PURE — the primary TDD target. Later tasks append the
 * orchestration and settings logic to this file.
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { allocateTransaction } from './bankAllocationService';
import { resolveRuleVatCode } from '../gl/ruleVatResolution';
import { postProvisional } from '../capture/provisionalPostingService';
import { getAutoPostSettings, autoPostRunSnapshot } from './autoPostSettingsService';
import { evaluate } from './autoPostGateDecision';
import { feedStateOf } from './bankFeedStateGuard';
import { claimRowsThenLockYears, journalYearOf } from '../core/numberYearLocks';
import { lockBankTransactionForUpdate } from './bankTxLock';

// Settings live in the sibling `autoPostSettingsService`, re-exported here
// because every caller has always imported them from this file. Split out to
// bring this one back under the repo's 300-line ceiling.
export {
  getAutoPostSettings,
  updateAutoPostSettings,
  autoPostRunSnapshot,
  type AutoPostSettings,
  type AutoPostSettingsPatch,
} from './autoPostSettingsService';
// The pure gate, split out the same way and re-exported for the same reason.
export { evaluate, type GateTx, type GateDecision } from './autoPostGateDecision';

type Row = DbRow;

// ── Types ────────────────────────────────────────────────────────────────────

export type AutoPostSource = 'import' | 'categorization' | 'manual';

export interface SweepResult {
  runId: string | null;
  posted: number;
  skipped: Array<{ txId: string; reason: string }>;
  /** Lines posted gross because s17(2)(a) denied the input tax. */
  vatDenied?: number;
  /** Lines posted gross because no supply can arise on the account. */
  nonSupplyCoerced?: number;
}

export const AUTO_POST_AGENT = 'ai:auto-post:v1';

// ── Sweep ────────────────────────────────────────────────────────────────────

interface SweepRow {
  id: string;
  status: string;
  amount: string | number;
  suggested_gl_account_id: string | null;
  suggested_confidence: string | number | null;
  suggested_vat_code: string | null;
  suggested_strategy: string | null;
  description: string | null;
  feed_state: string | null;
  transaction_date: string | Date;
}

/**
 * Evaluate the given txs and post the eligible ones through the existing
 * plumbing. source 'import' uses the provisional predictor path; everything
 * else uses the suggestion (allocate) path. The run row is created lazily on
 * the first successful post — a sweep that posts nothing leaves no run row.
 */
/**
 * Savepoint name for one row of the sweep. `withSavepoint` caps names at 31
 * characters, so this is a constant rather than an interpolation.
 */
const SWEEP_ROW_SAVEPOINT = 'auto_post_gate_line';

export async function sweep(
  companyId: string,
  txIds: string[],
  source: AutoPostSource,
  userId: string,
): Promise<SweepResult> {
  const settings = await getAutoPostSettings(companyId);
  if ((!settings.enabled && !settings.llmEnabled) || txIds.length === 0) {
    return { runId: null, posted: 0, skipped: [] };
  }

  const rows = (await sql`
    SELECT id, status, amount, suggested_gl_account_id, suggested_confidence,
           suggested_vat_code, suggested_strategy, description, feed_state, transaction_date
    FROM bank_transactions
    WHERE id = ANY(${txIds}::UUID[]) AND company_id = ${companyId}::UUID
  `) as unknown as SweepRow[];

  const skipped: Array<{ txId: string; reason: string }> = [];
  for (const r of rows) {
    if (feedStateOf(r) !== 'posted') {
      skipped.push({ txId: String(r.id), reason: `feed_state ${feedStateOf(r)}` });
    }
  }
  const postable = rows.filter((r) => feedStateOf(r) === 'posted');
  let runId: string | null = null;
  let posted = 0;
  let totalAmount = 0;
  // Counted, never silent — the same discipline as the rule sweep's
  // autoPostVatDenied/autoPostNonSupply. A gate that quietly drops a claim
  // every run is how a misconfiguration survives unnoticed.
  let vatDenied = 0;
  let nonSupplyCoerced = 0;

  async function ensureRun(strategy: string | null): Promise<string> {
    if (runId) return runId;
    const snap = autoPostRunSnapshot(strategy, settings);
    const r = (await sql`
      INSERT INTO bank_auto_post_runs (company_id, source, min_confidence, amount_cap, created_by)
      VALUES (${companyId}::UUID, ${source}, ${snap.minConfidence}::NUMERIC,
              ${snap.amountCap}::NUMERIC, ${userId}::UUID)
      RETURNING id
    `) as Row[];
    runId = String(r[0]!.id);
    return runId;
  }

  const isImport = source === 'import';

  // Decided before anything posts: the up-front year lock needs to know which rows will post.
  const decisions = new Map(postable.map((row) => [row.id, evaluate(
    { status: row.status, amount: Number(row.amount), suggestedGlAccountId: row.suggested_gl_account_id },
    isImport ? null : (row.suggested_confidence != null ? Number(row.suggested_confidence) : null),
    settings,
    isImport ? null : (row.suggested_strategy ?? null),
  )]));
  // Every year this sweep will number a journal in, ascending, before its first and after claiming those lines in
  // walk order with the bank-line lock (core/numberYearLocks.ts). A 55P03 on a year key posted nothing: the whole
  // sweep is retryable.
  await claimRowsThenLockYears(companyId, postable.filter((row) => decisions.get(row.id)!.outcome === 'post')
    .map((row) => ({ id: row.id, years: [journalYearOf(row.transaction_date)] })),
  (id) => lockBankTransactionForUpdate(companyId, id));

  for (const row of postable) {
    const decision = decisions.get(row.id)!;
    if (decision.outcome === 'skip') {
      skipped.push({ txId: row.id, reason: decision.reason });
      continue;
    }

    // One row per savepoint, exactly as the rule sweep does
    // (bankRulesMatchingService). Every request is ONE PostgreSQL transaction
    // on the ALS client, and `allocateTransaction` opens with a
    // `SELECT … FOR UPDATE` under `SET LOCAL lock_timeout` that sits OUTSIDE
    // its own withTransaction — so a row a peer is holding raises a real 55P03
    // that aborts the whole request. Without the savepoint the catch below
    // swallowed it, every later row failed 25P02 with a skip reason about the
    // abort rather than about itself, and the COMMIT threw away the posts this
    // sweep had already made while the response still reported success.
    //
    // `runId` is restored on rollback: `ensureRun` INSERTs the run row inside
    // the savepoint, so a row that mints the run and then fails leaves the
    // in-memory id pointing at a row that no longer exists — which the next row
    // would write into `auto_post_run_id`.
    const runIdBeforeRow: string | null = runId;
    try {
      const skipReason = await withSavepoint(SWEEP_ROW_SAVEPOINT, async (): Promise<string | null> => {
        if (isImport) {
          const res = await postProvisional(companyId, row.id, userId, { minConfidence: settings.minConfidence });
          if (!res.journalEntryId) {
            return res.skipped ?? 'no target';
          }
        } else {
          // THE UNATTENDED POSTING BOUNDARY. `allocateTransaction` is the
          // ATTENDED path and deliberately coerces nothing — the screen warned
          // and the user's choice stands. Nobody is watching here, so the two
          // VAT guards run before the call rather than inside it: s17(2)(a)
          // entertainment denial, and the accounts on which no supply can arise
          // at all. Without this the gate posts `suggested_vat_code` verbatim,
          // and a high-confidence LLM suggestion of 'standard' on a salary
          // account is exactly the R237,021.60 shape this feature exists to
          // stop — just arriving through a different door than the rule sweep.
          const requestedVat = row.suggested_vat_code ?? undefined;
          const guarded = await resolveRuleVatCode({
            allocType: 'account',
            companyId,
            requestedVatCode: requestedVat ?? 'none',
            glAccountId: row.suggested_gl_account_id,
            denialContext: { bankTxId: row.id, source: 'auto_post_gate' },
            guardContext: { bankTxId: row.id, ruleName: 'auto-post gate' },
          });
          // Only substitute when a guard actually fired. Otherwise pass the
          // original value through untouched, `undefined` included, so a row
          // nobody objected to posts exactly as it did before this guard existed.
          const effectiveVat = guarded.denied || guarded.nonSupplyCoerced
            ? guarded.vatCode : requestedVat;
          await allocateTransaction(
            companyId, row.id, row.suggested_gl_account_id, userId,
            row.description ?? undefined, 'account', undefined,
            effectiveVat,
            undefined, undefined, undefined, undefined,
            { postingAgent: AUTO_POST_AGENT },
          );
          if (guarded.denied) vatDenied += 1;
          if (guarded.nonSupplyCoerced) nonSupplyCoerced += 1;
        }
        const id = await ensureRun(isImport ? null : (row.suggested_strategy ?? null));
        await sql`
          UPDATE bank_transactions SET auto_post_run_id = ${id}::UUID
          WHERE id = ${row.id}::UUID AND company_id = ${companyId}::UUID
        `;
        return null;
      });
      if (skipReason !== null) {
        skipped.push({ txId: row.id, reason: skipReason });
        continue;
      }
      posted += 1;
      totalAmount += Math.abs(Number(row.amount));
    } catch (err) {
      // The savepoint took the JE and the run-tag back together, so the
      // orphaned-JE case this used to report can no longer arise. It also took
      // back the `bank_auto_post_runs` row if THIS row minted it.
      runId = runIdBeforeRow;
      const reason = err instanceof Error ? err.message : String(err);
      log.warn('Auto-post failed for bank transaction — skipping', { companyId, txId: row.id, reason }, 'auto-post-gate');
      skipped.push({ txId: row.id, reason });
    }
  }

  if (runId) {
    await sql`
      UPDATE bank_auto_post_runs
      SET posted_count = ${posted}, total_amount = ${totalAmount}::NUMERIC
      WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID
    `;
  }

  log.info('Auto-post sweep complete', { companyId, source, posted, skipped: skipped.length, runId }, 'auto-post-gate');
  if (vatDenied > 0 || nonSupplyCoerced > 0) {
    log.warn(
      'Auto-post gate dropped VAT claims before posting',
      { companyId, vatDenied, nonSupplyCoerced },
      'autoPostGateService',
    );
  }
  return { runId, posted, skipped, vatDenied, nonSupplyCoerced };
}
