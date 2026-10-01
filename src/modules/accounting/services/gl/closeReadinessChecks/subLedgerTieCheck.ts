/**
 * The AR / AP "sub-ledger ties to GL" close gate, shared by arSubLedgerCheck
 * and apSubLedgerCheck.
 *
 * ── WHY THIS READS reconcileSubledger ──────────────────────────────────────
 *
 * The gate used to sum each document's CURRENT balance, filtered by CURRENT
 * status, with invoice_date <= period end, and compare it with the control
 * balance AS AT period end. The two sides were on different dates: an invoice
 * open at period end and paid since was dropped from the subledger side while
 * its debit was still in the GL side, so every past period read "sub-ledger
 * R0.00 vs GL R210,573.82" on books that tie to the cent — and
 * close_fiscal_period refused every month-end on a false failure.
 *
 * `reconcileSubledger(companyId, role, asAt)` already moves BOTH sides to the
 * date (settlement rewind shared with the aging reports; control balance
 * bounded by entry_date) and decomposes the difference into typed items on the
 * `subledger_to_control` bridge. The gate is a verdict over those items.
 *
 * ── WHICH ITEMS ARE A TIE FAILURE ──────────────────────────────────────────
 *
 * Tolerated — the subledger does not net them by design, and they are not
 * errors: `unapplied_receipt` (cash on the control account WITH a payment /
 * receipt document, not yet applied; AR and AP both use this code),
 * `unapplied_credit_note` (approved credit not yet consumed) and
 * `settlement_before_document` (a document dated AFTER the period end whose
 * payment / credit was posted on or before it — a prepayment applied FIFO to a
 * later bill; on Velocity Fibre all 700 former document_not_on_control_account
 * items across 32 month-ends were this, and none was a real cut-off error).
 *
 * Everything else on the control bridge IS the failure: a document dated IN
 * the period whose journal is not on the control account as at the date
 * (`document_not_on_control_account` — cut-off / missing posting), an unlinked
 * document, a posting with no document behind it, and the residual
 * `unexplained_difference`. Σ|amount| of those: <= 0.01 pass, <= 100 warn,
 * else fail. `aged_to_subledger` items are ignored — they explain the aged
 * report, not the GL.
 *
 * ── COULD NOT COMPUTE ──────────────────────────────────────────────────────
 *
 * A throw or a null side returns `warn` with a "Could not compute" reason,
 * which close_fiscal_period treats as a blocker. Never a fabricated pass. The
 * reconciliation runs in its OWN savepoint (nested inside the orchestrator's
 * per-check one, LIFO on the single request connection) so a DB error inside
 * it is rolled back before this check returns its row.
 */

import { withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { reconcileSubledger } from '../../reconciliation/subledgerReconciliationService';
import type { ReconcilingItem } from '../../reconciliation/reconcilingItemTypes';
import type { ChecklistItem } from '../periodCloseReadinessService';
import { UNCOMPUTED_REASON_PREFIX } from './uncomputedReason';

/** Amounts within this tolerance (ZAR) are treated as equal. */
export const SUB_LEDGER_TOLERANCE = 0.01;

/** Failing items above this total (ZAR) escalate from warn to fail. */
export const SUB_LEDGER_FAIL_THRESHOLD = 100;

/** Control-bridge items that are legitimate timing, not a tie failure. */
export const TOLERATED_ITEM_TYPES: ReadonlySet<string> = new Set([
  'unapplied_receipt',
  'unapplied_credit_note',
  'settlement_before_document',
]);

/** Document numbers quoted per failing item before "…". */
const MAX_DOC_NUMBERS = 4;

interface TieConfig {
  role: 'ar' | 'ap';
  key: 'ar_ties' | 'ap_ties';
  label: string;
  fixHref: string;
  /** "receivable" / "payable" — the GL side's name in the reason text. */
  controlNoun: string;
}

const r = (n: number): string => `R${n.toFixed(2)}`;

function describeFailing(item: ReconcilingItem): string {
  const nums = item.documentNumbers.length > 0 ? item.documentNumbers : item.documentIds;
  if (nums.length === 0) return `${item.type} ${r(item.amount)}`;
  const shown = nums.slice(0, MAX_DOC_NUMBERS).join(', ');
  const more = nums.length > MAX_DOC_NUMBERS ? `, +${nums.length - MAX_DOC_NUMBERS} more` : '';
  return `${item.type} ${r(item.amount)} (${nums.length}: ${shown}${more})`;
}

function describeTolerated(items: readonly ReconcilingItem[]): string {
  if (items.length === 0) return '';
  const parts = items.map((i) => `${i.type} ${r(i.amount)} (${i.documentIds.length} doc(s))`);
  return ` Tolerated, not errors: ${parts.join('; ')}.`;
}

export async function subLedgerTieCheck(
  companyId: string,
  period: { endDate: string },
  cfg: TieConfig,
): Promise<ChecklistItem> {
  const base = { key: cfg.key, label: cfg.label, fixHref: cfg.fixHref };
  const upper = cfg.role.toUpperCase();

  let rec: Awaited<ReturnType<typeof reconcileSubledger>>;
  try {
    rec = await withSavepoint(`${cfg.role}_tie_recon`, () =>
      reconcileSubledger(companyId, cfg.role, period.endDate),
    );
  } catch (err) {
    log.error('close-readiness sub-ledger tie could not reconcile', {
      companyId, role: cfg.role, asAt: period.endDate, error: err,
    }, 'accounting');
    return {
      ...base,
      status: 'warn',
      reason: `${UNCOMPUTED_REASON_PREFIX} — the ${upper} sub-ledger reconciliation as at ${period.endDate} failed to run.`,
    };
  }

  const { subledgerTotal, controlAccountBalance } = rec;

  if (subledgerTotal === null) {
    return {
      ...base,
      status: 'warn',
      reason: `${UNCOMPUTED_REASON_PREFIX} — no ${upper} sub-ledger as at ${period.endDate}${rec.subledgerUnavailable ? ` (${rec.subledgerUnavailable.reason})` : ''}.`,
    };
  }
  if (controlAccountBalance === null) {
    // No control account at all. With nothing open there is nothing to tie —
    // the pre-existing 0 vs 0 pass for a company that has never invoiced.
    if (Math.abs(subledgerTotal) <= SUB_LEDGER_TOLERANCE) {
      return {
        ...base,
        status: 'pass',
        reason: `No ${cfg.controlNoun} control account and no open ${upper} documents as at ${period.endDate}.`,
      };
    }
    return {
      ...base,
      status: 'warn',
      reason: `${UNCOMPUTED_REASON_PREFIX} — ${upper} sub-ledger ${r(subledgerTotal)} as at ${period.endDate} but no GL account is typed as the ${cfg.controlNoun} control account.`,
    };
  }

  const bridge = rec.reconcilingItems.filter((i) => i.bridge === 'subledger_to_control');
  const tolerated = bridge.filter((i) => TOLERATED_ITEM_TYPES.has(i.type));
  const failing = bridge.filter((i) => !TOLERATED_ITEM_TYPES.has(i.type) && i.amount !== 0);
  const failingTotal = Math.round(failing.reduce((s, i) => s + Math.abs(i.amount), 0) * 100) / 100;

  const sides = `${upper} sub-ledger ${r(subledgerTotal)} vs GL ${cfg.controlNoun} ${r(controlAccountBalance)} as at ${period.endDate}`;

  if (failingTotal <= SUB_LEDGER_TOLERANCE) {
    return {
      ...base,
      status: 'pass',
      reason: `${upper} sub-ledger (${r(subledgerTotal)}) matches GL ${cfg.controlNoun} control account (${r(controlAccountBalance)}) as at ${period.endDate}.${describeTolerated(tolerated)}`,
    };
  }

  return {
    ...base,
    status: failingTotal > SUB_LEDGER_FAIL_THRESHOLD ? 'fail' : 'warn',
    reason: `${sides} — ${r(failingTotal)} does not tie: ${failing.map(describeFailing).join('; ')}.${describeTolerated(tolerated)}`,
  };
}
