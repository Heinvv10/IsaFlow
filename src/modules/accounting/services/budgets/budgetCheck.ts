/**
 * Budget check at approval (budgets P5 spec §3b/§3c with the census corrections). Document-agnostic:
 * the bill adapter is `ap/supplierInvoiceBudgetCheck.ts`.
 *
 * Lock design (§3c, census T2):
 * - `warn` / `off`: no lock. Two racing warn approvals may both read the same remaining; both are
 *   recorded and the overspend alert catches the result.
 * - `block`: ONE per-company transaction advisory lock, `budget_check:<company>` (seed 954), taken
 *   FIRST, before any document lock, with a bounded wait (`withRowLockBudget`, 5 s, then
 *   `BudgetCheckLockTimeoutError`, 503). `openBudgetGate` reads the policy unlocked and takes the
 *   lock only for `block`; `checkDocumentBudget` re-reads the policy under the document lock, and a
 *   policy that became `block` in between, with no lock held, is a retryable refusal (`mustRetryForLock`).
 * - Callers that already hold document locks pass lock mode `none` (lock-free "refuse if over").
 *
 * Events (`budget_check_events`, 954): pass / warn / override rows are written HERE, inside the
 * approval's own savepoint, so they stand or fall with the approval. A refusal is THROWN and its
 * savepoint rolls back, so its `refused` row is written by whoever catches it, outside that
 * savepoint, on the request transaction (`recordBudgetRefusal`; census finding 4). Every event also
 * writes `audit_log` (entity `budget`). `decided_by` is the session user when there is one (954's
 * trigger); a caller with no session (the service pool) is recorded as the actor it passes.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als } from '@/lib/als';
import { logAuditOrThrow } from '../core/auditTrailService';
import { withRowLockBudget } from '../core/rowLockBudget';
import { monthKeyToDate } from '../reports/budgetPeriodWindow';
import { MAX_REMAINING_KEYS, remainingFor, remainingKeysProblem } from './remainingBudget';
import type { RemainingResult } from './remainingBudgetCore';
import {
  decideBudgetOutcome, distinctKeys, mustRetryForLock, sliceLines, type DocumentLine, type UnlabelledLine,
} from './budgetCheckCore';
import {
  BudgetCheckLockTimeoutError, BudgetExceededError, BudgetReasonRequiredError, isBudgetPolicy,
  type BudgetCheckContext, type BudgetCheckLine, type BudgetCheckResult, type BudgetDocumentType, type BudgetGate,
  type BudgetLockMode, type BudgetOutcome, type BudgetPolicy, type BudgetRefusalEvent,
} from './budgetCheckTypes';

/** The account label of a document line that names no account. */
export const NO_ACCOUNT_LABEL = 'No account';

/** pg_advisory_xact_lock's second key part: the migration that made budget checks (954). */
const LOCK_SEED = 954;

/** The company's check policy; no settings row = the default, `warn` (decision 8). */
export async function readCheckPolicy(companyId: string): Promise<BudgetPolicy> {
  const rows = (await sql`
    SELECT check_policy FROM budget_control_settings WHERE company_id = ${companyId}::UUID
  `) as DbRow[];
  const policy = rows[0]?.check_policy;
  return isBudgetPolicy(policy) ? policy : 'warn';
}

/** The company budget lock, bounded (5 s → `BudgetCheckLockTimeoutError`). Re-entrant in one transaction. */
export async function takeBudgetCheckLock(companyId: string): Promise<void> {
  // Outside a request transaction an xact lock is released at the end of its own statement: it would guard nothing.
  if (!als.getStore()?.client) throw new Error('The budget check lock needs a request transaction');
  await withRowLockBudget(async () => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`budget_check:${companyId.toLowerCase()}`}, ${LOCK_SEED}))`;
  }, () => new BudgetCheckLockTimeoutError());
}

/**
 * Opens the gate for `take` / `held` callers: reads the policy unlocked and, for `block`, takes the
 * company lock. Call it BEFORE any document lock, outside any per-item savepoint. `none` reads nothing.
 */
export async function openBudgetGate(companyId: string, mode: Exclude<BudgetLockMode, 'held'> = 'take'): Promise<BudgetGate> {
  if (mode === 'none') return { policy: null, locked: false, mode: 'none' };
  const policy = await readCheckPolicy(companyId);
  if (policy === 'block') await takeBudgetCheckLock(companyId);
  return { policy, locked: policy === 'block', mode };
}

/** The gate an approval runs under: the caller's (`held`), opened here (`take`), or none. */
export async function gateFor(companyId: string, ctx: BudgetCheckContext): Promise<BudgetGate> {
  if (ctx.lock === 'held') {
    if (!ctx.gate) throw new Error('Budget check: lock mode held needs the gate the caller opened');
    return { ...ctx.gate, mode: 'held' };
  }
  return openBudgetGate(companyId, ctx.lock);
}

/**
 * Names each line's account and slice (code + name), company-scoped. A line with no account (`glAccountId` '':
 * a PO line nobody coded, census 7) is labelled "No account".
 */
export async function labelBudgetLines(companyId: string, lines: readonly UnlabelledLine[]): Promise<BudgetCheckLine[]> {
  const accounts = [...new Set(lines.map((l) => l.glAccountId).filter((a) => a !== ''))];
  const centres = [...new Set(lines.flatMap((l) => [l.cc1Id, l.cc2Id]).filter((v): v is string => v !== null))];
  const units = [...new Set(lines.map((l) => l.buId).filter((v): v is string => v !== null))];
  const name = new Map<string, string>();
  const put = (rows: DbRow[]) => {
    for (const r of rows) name.set(String(r.id).toLowerCase(), [r.code, r.name].filter((s) => s != null && s !== '').join(' '));
  };
  put((await sql`SELECT id, account_code AS code, account_name AS name FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND id = ANY(${accounts}::UUID[])`) as DbRow[]);
  if (centres.length > 0) {
    put((await sql`SELECT id, code, name FROM cost_centres WHERE company_id = ${companyId}::UUID AND id = ANY(${centres}::UUID[])`) as DbRow[]);
  }
  if (units.length > 0) {
    put((await sql`SELECT id, code, name FROM business_units WHERE company_id = ${companyId}::UUID AND id = ANY(${units}::UUID[])`) as DbRow[]);
  }
  return lines.map((l) => ({
    ...l,
    accountLabel: l.glAccountId === '' ? NO_ACCOUNT_LABEL : name.get(l.glAccountId) ?? l.glAccountId,
    sliceLabel: [l.cc1Id, l.cc2Id, l.buId].filter((v): v is string => v !== null).map((v) => name.get(v) ?? v).join(' / '),
  }));
}

/**
 * Options of a remaining read: the bills whose PO-linked lines count as billed whatever their status, and the PO
 * lines left out of committed (a PO judged against everything but itself, P5-3).
 */
interface BilledAs { excludeInvoiceId?: string | null; alsoBilledInvoiceIds?: readonly string[]; excludePoItemIds?: readonly string[] }

/** Remaining per slice for one month's lines. Skips every read when no primary version budgets these accounts that month. */
async function sliceMonth(companyId: string, lines: readonly DocumentLine[], month: string, billedAs: BilledAs): Promise<UnlabelledLine[]> {
  const keys = distinctKeys(lines, month);
  const noBudget = (): RemainingResult[] => keys.map((key) => ({
    key, versionId: null, grain: null, slice: { cc1Id: null, cc2Id: null, buId: null }, unassigned: false,
    budget: null, actual: 0, committed: 0, remaining: null,
  }));
  // A date outside the bounds the reader accepts cannot carry a budget (and approve refuses it anyway).
  if (remainingKeysProblem([month]) !== null) return sliceLines(lines, keys, noBudget());
  const any = (await sql`
    SELECT EXISTS (
      SELECT 1 FROM budget_month_amounts b JOIN budget_versions v ON v.id = b.version_id AND v.company_id = b.company_id
       WHERE b.company_id = ${companyId}::UUID AND v.is_primary
         AND b.gl_account_id = ANY(${keys.map((k) => k.glAccountId)}::UUID[]) AND b.month = ${monthKeyToDate(month)}::DATE
    ) AS any
  `) as DbRow[];
  if (any[0]?.any !== true) return sliceLines(lines, keys, noBudget());
  const results: RemainingResult[] = [];
  for (let i = 0; i < keys.length; i += MAX_REMAINING_KEYS) {
    results.push(...await remainingFor(companyId, keys.slice(i, i + MAX_REMAINING_KEYS), {
      excludeInvoiceId: billedAs.excludeInvoiceId ?? null, alsoBilledInvoiceIds: billedAs.alsoBilledInvoiceIds,
      excludePoItemIds: billedAs.excludePoItemIds,
    }));
  }
  return sliceLines(lines, keys, results);
}

/**
 * Remaining budget per slice for the document's lines: `month` unless a line names its own (a provisional's
 * reclass, P5-2 review B1). A credit on a slice with no budget (the reclass's VAT, an unbudgeted account) is
 * dropped: it can make nothing over. `alsoBilledInvoiceIds`: see `CommittedOptions`.
 */
export async function evaluateDocumentLines(
  companyId: string, lines: readonly DocumentLine[], month: string,
  opts: BilledAs & { labelAlways?: boolean } = {},
): Promise<BudgetCheckLine[]> {
  const byMonth = new Map<string, DocumentLine[]>();
  for (const l of lines) {
    if (l.amount === 0) continue;
    const m = l.month ?? month;
    byMonth.set(m, [...(byMonth.get(m) ?? []), l]);
  }
  const sliced: UnlabelledLine[] = [];
  for (const [m, ls] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) sliced.push(...await sliceMonth(companyId, ls, m, opts));
  const kept = sliced.filter((l) => l.budget !== null || l.amount > 0);
  // Nothing checked (every line "No budget"): an approval records nothing, so it reads no names; a preview asks for them.
  if (!opts.labelAlways && kept.every((l) => l.budget === null)) return kept.map((l) => ({ ...l, accountLabel: '', sliceLabel: '' }));
  return labelBudgetLines(companyId, kept);
}

export interface CheckedDocument {
  type: BudgetDocumentType;
  id: string;
  /** The number a person knows it by (audit entity_ref). */
  ref: string;
  month: string;
  lines: readonly DocumentLine[];
  excludeInvoiceId?: string | null;
  /** A PO's own lines: left out of committed, so the PO is not judged against itself (P5-3). */
  excludePoItemIds?: readonly string[];
}

/** How a refusal or warning names the document's own amount. */
const NOUN: Record<BudgetDocumentType, string> = { supplier_invoice: 'this bill', purchase_order: 'this order' };

/**
 * The check (§3b). Returns the result (pass / warn / override recorded), or throws
 * `BudgetReasonRequiredError` (nothing recorded), `BudgetExceededError` (its `event` is for the
 * catcher to record) or `BudgetCheckLockTimeoutError` (retryable). Runs under the document lock,
 * before the document's first write.
 */
export async function checkDocumentBudget(
  companyId: string, doc: CheckedDocument, ctx: BudgetCheckContext, gate: BudgetGate, actorId: string,
): Promise<BudgetCheckResult> {
  const policy = await readCheckPolicy(companyId);
  if (policy === 'off') return { policy, outcome: null, lines: [], warnings: [] };
  if (mustRetryForLock(policy, gate)) throw new BudgetCheckLockTimeoutError(true);

  const lines = await evaluateDocumentLines(companyId, doc.lines, doc.month, {
    excludeInvoiceId: doc.excludeInvoiceId, excludePoItemIds: doc.excludePoItemIds,
  });
  const decision = decideBudgetOutcome({
    policy, lines, channel: ctx.channel, reason: ctx.reason, override: ctx.override, actorRole: ctx.actorRole, figures: ctx.figures,
    documentNoun: NOUN[doc.type],
  });
  if (decision.kind === 'reason_required') throw new BudgetReasonRequiredError(decision.message, lines);
  if (decision.kind === 'refuse') {
    throw new BudgetExceededError(decision.message, {
      companyId, documentType: doc.type, documentId: doc.id, documentRef: doc.ref, policy, lines,
      reason: ctx.reason?.trim() || null, channel: ctx.channel, actorId, overrideRequested: ctx.override === true,
    }, decision.overrideRefused);
  }
  if (decision.event !== null) {
    await recordBudgetCheckEvent({
      companyId, documentType: doc.type, documentId: doc.id, documentRef: doc.ref, policy, lines,
      reason: decision.reason, channel: ctx.channel, actorId,
    }, decision.event);
  }
  return { policy, outcome: decision.event, lines, warnings: decision.warnings };
}

/**
 * The event's `lines` as stored: an override the actor asked for (and was refused) is marked on every line
 * (`overrideRequested: true`), so the record says so without a column of its own (review round 3).
 */
const storedLines = (e: BudgetRefusalEvent): string =>
  JSON.stringify(e.overrideRequested ? e.lines.map((l) => ({ ...l, overrideRequested: true })) : e.lines);

/** One `budget_check_events` row and its `audit_log` row (entity `budget`), on the current transaction. */
export async function recordBudgetCheckEvent(e: BudgetRefusalEvent, outcome: BudgetOutcome): Promise<void> {
  await sql`
    INSERT INTO budget_check_events (company_id, document_type, document_id, policy, outcome, lines, reason, channel, decided_by)
    VALUES (${e.companyId}::UUID, ${e.documentType}, ${e.documentId}::UUID, ${e.policy}, ${outcome},
            ${storedLines(e)}::JSONB, ${e.reason}, ${e.channel}, ${e.actorId})
  `;
  const over = e.lines.filter((l) => l.over);
  await logAuditOrThrow({
    companyId: e.companyId, userId: e.actorId, action: outcome === 'refused' ? 'reject' : 'approve',
    entityType: 'budget', entityId: e.documentId, entityRef: `Budget check ${e.documentRef}`.slice(0, 100),
    changes: {
      fields: [],
      metadata: {
        budgetCheck: outcome, policy: e.policy, channel: e.channel, documentType: e.documentType,
        overLines: String(over.length), checkedLines: String(e.lines.filter((l) => l.budget !== null).length),
        ...(e.reason ? { reason: e.reason } : {}),
        ...(e.overrideRequested ? { overrideRequested: 'true' } : {}),
      },
    },
  });
}

/**
 * Window in which a refusal identical to one already recorded is not written again: same document, actor,
 * channel, policy, lines (the override flag included) and reason. A refused override attempt, or a new reason,
 * is a different act and is recorded (review round 3, REPRO 4).
 */
export const REFUSAL_DEDUPE_SECONDS = 60;

/**
 * Records a refusal's `refused` event (and its audit row). Call it OUTSIDE the savepoint the refusal rolled
 * back. A retry refused for the same reason within REFUSAL_DEDUPE_SECONDS writes nothing (security review S2:
 * otherwise each click of a refused approve adds an event and an audit row). Returns whether it wrote.
 */
export async function recordBudgetRefusal(err: BudgetExceededError): Promise<boolean> {
  const e = err.event;
  const same = (await sql`
    SELECT 1 FROM budget_check_events
     WHERE company_id = ${e.companyId}::UUID AND document_type = ${e.documentType} AND document_id = ${e.documentId}::UUID
       AND outcome = 'refused' AND policy = ${e.policy} AND channel = ${e.channel}
       AND decided_by = COALESCE(auth.uid(), ${e.actorId}) AND lines = ${storedLines(e)}::JSONB
       AND reason IS NOT DISTINCT FROM ${e.reason}
       AND decided_at > clock_timestamp() - make_interval(secs => ${REFUSAL_DEDUPE_SECONDS})
     LIMIT 1
  `) as DbRow[];
  if (same.length > 0) return false;
  await recordBudgetCheckEvent(e, 'refused');
  return true;
}
