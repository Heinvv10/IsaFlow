/**
 * The approval gate — ONE judgement of whether a pay run may be approved,
 * used by approvePayrollRun (live), by its preview (the run page's
 * confirmation) and by findApprovalBlocker (the MCP dry run), so none of them
 * can greenlight what another refuses (W3-01 review).
 *
 * In order:
 *   1. status: draft / calculated / processed, or approved with no journal;
 *   2. a run that already carries its posted journal (reopened) may be
 *      re-approved onto it only while that journal is still live and its
 *      lines match what the run's header would post now. Live = status
 *      'posted' AND reversed_at IS NULL: reverseJournalEntry leaves the
 *      original at status 'posted' and marks it with reversed_at alone
 *      (journalEntryReversalClaim). A reversal is always whole — the contra
 *      mirrors every line and reversed_at is claimed once — so there is no
 *      partly reversed state. Reversing the contra re-books the amounts under a
 *      NEW journal while the original stays marked reversed, so it stays not
 *      live: the run must be approved onto a fresh journal. A run recalculated
 *      after posting would otherwise be re-locked onto a journal carrying
 *      the OLD figures while its header carries the new (BRK-596 REPRO4);
 *   3. otherwise every journal-plan blocker except 'run_not_approved', which
 *      approval itself resolves.
 *
 * `planHash` fingerprints what approval would do: the plan's lines and totals
 * and the journal it would re-lock onto. The page sends the hash it previewed
 * and approval refuses (409) when the run no longer hashes the same.
 */
import { createHash } from 'crypto';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { approvalStatusRefusal } from './payrollApprovalRefusal';
import {
  buildPayrollJournalPlan,
  type PayrollJournalNote,
  type PayrollJournalPlan,
} from './payrollJournalBuilder';

export interface PostedPayrollJournal {
  journalEntryId: string;
  entryNumber: string;
  status: string;
  reversedAt: string | null;
  lines: Array<{ glAccountId: string; accountCode: string; accountName: string; debit: number; credit: number }>;
  totalDebit: number;
  totalCredit: number;
}

export interface PayrollApprovalGate {
  plan: PayrollJournalPlan;
  /** The journal the run already carries, when it does. Approval posts nothing new onto it. */
  posted: PostedPayrollJournal | null;
  blocker: PayrollJournalNote | null;
  planHash: string;
}

const cents = (n: number): number => Math.round(n * 100);

async function readPostedJournal(companyId: string, journalId: string): Promise<PostedPayrollJournal | null> {
  const rows = (await sql`
    SELECT e.entry_number, e.status, e.reversed_at, l.gl_account_id, a.account_code, a.account_name,
           l.debit::float8 AS debit, l.credit::float8 AS credit
    FROM gl_journal_entries e
    LEFT JOIN gl_journal_lines l ON l.journal_entry_id = e.id AND l.company_id = e.company_id
    LEFT JOIN gl_accounts a ON a.id = l.gl_account_id AND a.company_id = e.company_id
    WHERE e.id = ${journalId}::uuid AND e.company_id = ${companyId}::uuid
    ORDER BY l.debit DESC, a.account_code, l.id
  `) as DbRow[];
  const head = rows[0];
  if (!head) return null;
  const lines = rows.filter((r) => r.gl_account_id != null).map((r) => ({
    glAccountId: String(r.gl_account_id),
    accountCode: String(r.account_code ?? ''),
    accountName: String(r.account_name ?? ''),
    debit: Number(r.debit) || 0,
    credit: Number(r.credit) || 0,
  }));
  return {
    journalEntryId: journalId,
    entryNumber: String(head.entry_number ?? ''),
    status: String(head.status),
    reversedAt: head.reversed_at == null ? null : new Date(head.reversed_at as string | Date).toISOString(),
    lines,
    totalDebit: cents(lines.reduce((s, l) => s + l.debit, 0)) / 100,
    totalCredit: cents(lines.reduce((s, l) => s + l.credit, 0)) / 100,
  };
}

/** Net cents per GL account — the shape two journals must share to be the same journal. */
function byAccount(lines: Array<{ glAccountId: string | null; debit: number; credit: number }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) {
    const k = l.glAccountId ?? 'missing';
    m.set(k, (m.get(k) ?? 0) + cents(l.debit) - cents(l.credit));
  }
  for (const [k, v] of m) if (v === 0) m.delete(k);
  return m;
}

function sameJournal(plan: PayrollJournalPlan, posted: PostedPayrollJournal): boolean {
  const a = byAccount(plan.lines);
  const b = byAccount(posted.lines);
  return a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
}

function hashOf(plan: PayrollJournalPlan): string {
  return createHash('sha256').update(JSON.stringify({
    status: plan.status,
    posted: plan.alreadyPostedJournalId,
    lines: plan.lines.map((l) => [l.glAccountId, l.accountCode, cents(l.debit), cents(l.credit)]),
    totals: Object.entries(plan.totals).map(([k, v]) => [k, cents(v)]),
  })).digest('hex');
}

function judge(plan: PayrollJournalPlan, posted: PostedPayrollJournal | null): PayrollJournalNote | null {
  const statusRefusal = approvalStatusRefusal(plan.status, plan.alreadyPostedJournalId);
  if (statusRefusal) return { code: 'status_not_approvable', detail: statusRefusal };
  if (plan.alreadyPostedJournalId) {
    const state = !posted ? 'missing' : posted.reversedAt ? 'reversed' : posted.status !== 'posted' ? `'${posted.status}'` : null;
    if (state || !posted) {
      return {
        code: 'posted_journal_not_live',
        detail: `The journal this run posted (${plan.alreadyPostedJournalId}) is ${state ?? 'missing'}, so the run cannot be re-approved onto it.`,
      };
    }
    if (!sameJournal(plan, posted)) {
      return {
        code: 'recalculated_after_posting',
        detail: 'This run was recalculated after its journal posted, so its figures no longer match that journal — reverse the posted journal first.',
      };
    }
    return null;
  }
  return plan.blockers.find((b) => b.code !== 'run_not_approved') ?? null;
}

/** Null when the run is not in this company. Read-only. */
export async function judgePayrollApproval(companyId: string, runId: string): Promise<PayrollApprovalGate | null> {
  const plan = await buildPayrollJournalPlan(companyId, runId);
  if (!plan) return null;
  const posted = plan.alreadyPostedJournalId ? await readPostedJournal(companyId, plan.alreadyPostedJournalId) : null;
  return { plan, posted, blocker: judge(plan, posted), planHash: hashOf(plan) };
}
