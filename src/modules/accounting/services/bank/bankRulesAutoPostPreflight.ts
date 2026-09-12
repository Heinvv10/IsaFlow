/**
 * What the sweep can know about a candidate line WITHOUT attempting it.
 *
 * A refused line stays `imported`, so it matches its rule again on every
 * import, and every attempt costs the request's authority hold and a slot of
 * the per-request attempt budget (authorityHoldLimits.ts). Lines that can
 * never clear until a person acts — a closed or missing fiscal period, a
 * lockdown date, a company approval policy that binds the amount — must not
 * consume that budget run after run and starve the lines that could post.
 * Each answer here is READ from the same rows and the same predicates the
 * controlled allocation refuses on (`postingPeriodBlock`, the kernel's own
 * `controlledOperationApprovalRequiredForAmount`); none restates a rule. The
 * controlled path still decides at execute time — this only skips lines it
 * would refuse anyway.
 */

import Decimal from 'decimal.js';
import { fmtDate } from '@/lib/fmtDate';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { requireControlTx } from '../controls/context';
import { controlledOperationApprovalRequiredForAmount } from '../controls/approvalExecutionService';
import { postingPeriodBlock } from '../gl/postingPeriodGuard';
import { allocationMoney } from './bankAllocationPlan';
import type { AutoPostRefusal } from './bankRuleAutoPostRefusal';

export type LockdownFacts = { lockdown_enabled?: unknown; lockdown_date?: unknown };

/** The company's lockdown facts, read once per sweep. */
export async function loadLockdownFacts(companyId: string): Promise<LockdownFacts> {
  const rows = (await sql`SELECT lockdown_enabled, lockdown_date::text AS lockdown_date FROM companies WHERE id = ${companyId}::UUID`) as DbRow[];
  return rows[0] ?? {};
}

/**
 * The date-based refusal a candidate would meet, from the `period_status`
 * `findMatchingTxs` joined onto it and the company's lockdown — or null when
 * its date can post.
 */
export function dateRefusal(tx: Record<string, unknown>, company: LockdownFacts): AutoPostRefusal | null {
  if (tx.period_status === null || tx.period_status === undefined) return { kind: 'no_period' };
  // fmtDate, never toISOString: on a UTC+2 host the latter shifts a local-midnight Date back a day.
  const block = postingPeriodBlock(tx.period_status, company, fmtDate(tx.transaction_date));
  if (block?.kind === 'period') return { kind: 'closed_period' };
  if (block?.kind === 'lockdown') return { kind: 'lockdown' };
  return null;
}

/**
 * The kernel's own read-only approval question for a bank allocation of this
 * amount (`bank_allocation.post` binds `payment` rules). An aggregate-window
 * policy answers "required" conservatively; the execute path is the authority
 * either way, and refuses the same lines this skips.
 */
export async function approvalRequiredForLine(amount: unknown): Promise<boolean> {
  const money = allocationMoney(new Decimal(String(amount)).abs().toFixed());
  return controlledOperationApprovalRequiredForAmount(requireControlTx(), 'bank_allocation.post', money);
}
