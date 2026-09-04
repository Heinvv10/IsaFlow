/**
 * Shared argument shape and response rendering for the two reclassification
 * tools, so `propose_reclassification` and the dry run inside
 * `post_reclassification_batch` cannot drift apart.
 *
 * Everything here is pre-write. The plan it builds runs EVERY row-state guard
 * the live path runs — period closed, no period, entry reversed, already moved,
 * a contra leg, VAT locked — and only the write itself is skipped. A dry run
 * that passes where the real call refuses is worse than no dry run.
 */
import type { McpToolContext, McpToolResult } from '../types';
import {
  isRefusal,
  planReclassification,
  MAX_RECLASS_LINES,
  type ReclassPlan,
} from '@/modules/accounting/services/gl/reclassification/plan';
import { NOT_FOUND, guardCastableArgs, strArg, toolError } from './toolHelpers';

export const RECLASS_ARG_SCHEMA = {
  source_account_id: {
    type: 'string',
    description: 'GL account UUID the amounts currently sit on.',
  },
  target_account_id: {
    type: 'string',
    description: 'GL account UUID they should sit on instead. Must differ from the source.',
  },
  from: {
    type: 'string',
    format: 'date',
    description:
      'Only consider source lines whose journal is dated on or after this day (YYYY-MM-DD). '
      + `Omit for no lower bound. Use from/to to keep a batch under ${MAX_RECLASS_LINES} lines.`,
  },
  to: {
    type: 'string',
    format: 'date',
    description: 'Only consider source lines dated on or before this day (YYYY-MM-DD).',
  },
  posting_date: {
    type: 'string',
    format: 'date',
    description:
      'Date EVERY reclassification journal on this one day instead of on its own source '
      + "line's date. This is how a closed month is corrected from an open one — and it "
      + 'MOVES THE CHARGE BETWEEN PERIODS: the closed month keeps the original '
      + 'classification and this period carries the correction. Omit it and each journal '
      + 'is dated at its source line, which is period-neutral but skips every line whose '
      + 'own period is closed.',
  },
} as const;

export function guardReclassArgs(args: Record<string, unknown>): McpToolResult | null {
  return guardCastableArgs(args, {
    uuid: ['source_account_id', 'target_account_id'],
    date: ['from', 'to', 'posting_date'],
  });
}

/**
 * Parses, ownership-checks and plans. Returns the plan, or the `toolError` the
 * caller must return unchanged — pre-write, so there is nothing to unwind and
 * the registry audits the refusal with a NULL idempotency key.
 */
export async function planFromArgs(
  args: Record<string, unknown>,
  ctx: McpToolContext,
  /**
   * TRUE only on the path that is about to write. A preview must not hold a
   * lock that blocks every real batch on the account for its duration.
   */
  lockCandidateLines = false,
): Promise<ReclassPlan | McpToolResult> {
  const sourceAccountId = strArg(args, 'source_account_id');
  const targetAccountId = strArg(args, 'target_account_id');
  if (!sourceAccountId || !targetAccountId) {
    return toolError('source_account_id and target_account_id are required');
  }
  const bad = guardReclassArgs(args);
  if (bad) return bad;

  let plan;
  try {
    plan = await planReclassification({
      companyId: ctx.companyId,
      sourceAccountId,
      targetAccountId,
      from: strArg(args, 'from') ?? null,
      to: strArg(args, 'to') ?? null,
      postingDate: strArg(args, 'posting_date') ?? null,
      lockCandidateLines,
    });
  } catch (err) {
    // The candidate-line lock timed out: another batch is mid-flight on lines
    // this one wants. Write-free by construction — the lock is taken before
    // anything is posted — so this is a PRE-write refusal and a toolError is
    // the correct shape. The registry audits it with a NULL idempotency key,
    // leaving the key usable for the retry the message asks for. Anything else
    // rethrows: only this one condition is known to be write-free.
    if (typeof err === 'object' && err !== null
        && (err as { code?: unknown }).code === 'RECLASS_LINE_LOCKED') {
      return toolError((err as Error).message);
    }
    throw err;
  }
  if (isRefusal(plan)) {
    // The shared generic text for an id that is not in this company, so a
    // cross-tenant probe reads identically to a genuine miss.
    return toolError(plan.refused === 'NOT_FOUND' ? NOT_FOUND : plan.refused);
  }
  return plan;
}

export function isPlan(x: ReclassPlan | McpToolResult): x is ReclassPlan {
  return 'movable' in x;
}

const round2 = (v: number): number => {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
};

/** The journals themselves — the point of a dry run, not a count of them. */
export function renderJournals(plan: ReclassPlan) {
  const byId = new Map([
    [plan.source.id, plan.source],
    [plan.target.id, plan.target],
  ]);
  return plan.drafts.map((d) => ({
    date: d.date,
    description: d.description,
    totalDebit: d.totalDebit,
    totalCredit: d.totalCredit,
    lines: d.lines.map((l) => {
      const account = byId.get(l.glAccountId);
      return {
        accountId: l.glAccountId,
        accountCode: account?.code ?? '',
        accountName: account?.name ?? '',
        debit: l.debit,
        credit: l.credit,
        description: l.description ?? null,
      };
    }),
  }));
}

/**
 * Gross and net per source account, stated separately and never conflated —
 * `49775626 Unallocated Income` is R31.6m gross against R659k net, and a
 * net-only reading calls that harmless while 109 lines change account.
 *
 * SIGN CONVENTION, and it differs from `account_movement` on purpose.
 * `grossMoved`/`netMoved` are raw ledger movement, DEBIT-POSITIVE, because they
 * describe the lines being carried and a line is a debit or a credit regardless
 * of what kind of account it sits on. `account_movement` is NORMAL-BALANCE
 * signed, because it describes an account balance. A credit-side move therefore
 * shows a negative `netMoved` and a positive movement on a revenue target.
 */
export function renderMovement(plan: ReclassPlan) {
  const gross = plan.movable.reduce((t, m) => t + m.debit + m.credit, 0);
  const net = plan.movable.reduce((t, m) => t + m.debit - m.credit, 0);
  return {
    sourceAccountCode: plan.source.code,
    sourceAccountName: plan.source.name,
    linesMoved: plan.movable.length,
    grossMoved: round2(gross),
    netMoved: round2(net),
    // The route to the documents behind every figure above (CONTRACTS §3).
    sourceJournalEntryIds: [...new Set(plan.movable.map((m) => m.journalEntryId))],
  };
}

export function renderSkips(plan: ReclassPlan) {
  return plan.skipped.map((s) => ({
    id: s.lineId,
    journal_entry_id: s.journalEntryId,
    entry_number: s.entryNumber,
    entry_date: s.entryDate,
    reason: s.reason,
    amount: round2(s.amount),
  }));
}

/**
 * Which dates the journals would carry.
 *
 * `postingDate` is the CALLER's own argument, echoed back — not inferred from
 * the drafts. Deriving it from `drafts[0].date` claimed a posting date whenever
 * every source line happened to fall on one day, which is precisely the case
 * where the caller chose NOT to move the charge between periods. This field is
 * the one that distinguishes period-neutral from period-moving, so it has to
 * report what was asked for rather than what the data looked like.
 */
export function renderPeriods(plan: ReclassPlan) {
  return {
    postingDate: plan.postingDate,
    periodNeutral: plan.postingDate === null,
    journalDates: [...new Set(plan.drafts.map((d) => d.date))],
  };
}
