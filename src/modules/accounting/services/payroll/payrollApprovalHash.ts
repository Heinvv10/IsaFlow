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
