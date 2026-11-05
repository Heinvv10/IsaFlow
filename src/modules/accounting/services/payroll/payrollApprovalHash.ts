/**
 * The approval gate's plan hash (payrollApprovalGate): what approval would do — which run, the journal's date and
 * description, its lines (account, CC1, amounts) and totals, and the journal it would re-lock onto or replace. The
 * caller sends the hash it previewed; approval refuses (409) when the run no longer hashes the same.
 */
import { createHash } from 'crypto';
import type { PayrollJournalPlan } from './payrollJournalBuilder';
import type { PostedPayrollJournal } from './payrollApprovalGate';

const cents = (n: number): number => Math.round(n * 100);

export function hashOf(
  plan: PayrollJournalPlan,
  posted: PostedPayrollJournal | null,
  replaces: PostedPayrollJournal | null,
  revision: string | null,
): string {
  return createHash('sha256').update(JSON.stringify({
    run: plan.runId,
    status: plan.status,
    entryDate: plan.entryDate,
    description: plan.description,
    posted: posted?.journalEntryId ?? null,
    replaces: replaces?.journalEntryId ?? null,
    revision,
    // CC1 is in it: it changes what posts, so a preview taken before a centre moved cannot approve the new split.
    lines: plan.lines.map((l) => [l.glAccountId, l.accountCode, l.cc1Id, cents(l.debit), cents(l.credit)]),
    totals: Object.entries(plan.totals).map(([k, v]) => [k, cents(v)]),
  })).digest('hex');
}

/**
 * Whether a FRESH journal plan rebuilt for an approved run is the plan its approval hashed. Approval hashed the run
 * before its own status write, so the stored hash carries the status the run was approved from (draft, calculated,
 * or a stranded 'approved'); a fresh post links no journal and replaces none. A run approved onto a journal it then
 * replaced (`replaces`) cannot be told this way and does not match: that approval posted in the same transaction.
 */
export function matchesApprovedPlanHash(plan: PayrollJournalPlan, revision: string | null, approvedHash: string): boolean {
  return ['draft', 'calculated', 'approved'].some((status) => hashOf({ ...plan, status }, null, null, revision) === approvedHash);
}
