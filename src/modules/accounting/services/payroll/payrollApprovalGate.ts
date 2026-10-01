/**
 * The approval gate — ONE judgement of whether a pay run may be approved,
 * used by approvePayrollRun (live) and by previewPayrollApproval (the run
 * page's confirmation and the MCP dry run), so none of them
 * can greenlight what another refuses (W3-01 review).
 *
 * In order:
 *   1. status: draft / calculated / processed, or approved with no journal;
 *   2. a run that already carries its posted journal (reopened) may be
 *      re-approved onto it only while that journal is still live and its
 *      figures match what the run's header would post now (`figures`: each
 *      credit account and the labour total, to the cent). Live = status
 *      'posted' AND reversed_at IS NULL: reverseJournalEntry leaves the
 *      original at status 'posted' and marks it with reversed_at alone
 *      (journalEntryReversalClaim). A reversal is always whole — the contra
 *      mirrors every line and reversed_at is claimed once — so there is no
 *      partly reversed state. Reversing the contra re-books the amounts under a
 *      NEW journal while the original stays marked reversed. A linked journal
 *      that is reversed and whose reversal still stands is REPLACED: approval
 *      unlinks it and posts a fresh journal (`replaces`). One whose reversal
 *      was reversed in turn is refused — a fresh journal would book the month
 *      twice. A run recalculated
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
  /** True while the journal's reversal (contra) is itself posted and not reversed. */
  reversalStands: boolean;
  lines: Array<{ glAccountId: string; accountCode: string; accountName: string; debit: number; credit: number }>;
  totalDebit: number;
  totalCredit: number;
}

export interface PayrollApprovalGate {
  plan: PayrollJournalPlan;
  /** The journal the run already carries, when it does. Approval posts nothing new onto it. */
  posted: PostedPayrollJournal | null;
  /** The reversed journal the run still links. Approval unlinks it and posts a fresh one. `posted` is then null. */
  replaces: PostedPayrollJournal | null;
  blocker: PayrollJournalNote | null;
  planHash: string;
}

const cents = (n: number): number => Math.round(n * 100);

async function readPostedJournal(companyId: string, journalId: string): Promise<PostedPayrollJournal | null> {
  const rows = (await sql`
    SELECT e.entry_number, e.status, e.reversed_at, l.gl_account_id, a.account_code, a.account_name,
           EXISTS (SELECT 1 FROM gl_journal_entries c
                    WHERE c.reversal_of_id = e.id AND c.company_id = e.company_id
                      AND c.status = 'posted' AND c.reversed_at IS NULL) AS reversal_stands,
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
    reversalStands: head.reversal_stands === true,
    lines,
    totalDebit: cents(lines.reduce((s, l) => s + l.debit, 0)) / 100,
    totalCredit: cents(lines.reduce((s, l) => s + l.credit, 0)) / 100,
  };
}

/**
 * What a recalculation changes, in cents: every credit by GL account (PAYE,
 * UIF, SDL, deductions, net pay — each a header total) and the labour cost as
 * ONE total. The labour debit's split across cost-centre accounts is left out
 * on purpose: it follows today's cost centres, mappings and allocations, and
 * (before the split's reads were ordered) the heap's order for its rounding
 * cent. None of that is the run being recalculated, and a journal is not wrong
 * for having been posted under the split of its day (breaker B, C).
 */
function figures(lines: Array<{ glAccountId: string | null; debit: number; credit: number }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) {
    const k = cents(l.debit) !== 0 ? 'labour' : l.glAccountId ?? 'missing';
    m.set(k, (m.get(k) ?? 0) + cents(l.debit) - cents(l.credit));
  }
  for (const [k, v] of m) if (v === 0) m.delete(k);
  return m;
}

function sameFigures(plan: PayrollJournalPlan, posted: PostedPayrollJournal): boolean {
  const a = figures(plan.lines);
  const b = figures(posted.lines);
  return a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
}

/**
 * A linked journal that was reversed, and whose reversal still stands, is out
 * of the ledger for good (a reversal is whole, and reversed_at is claimed
 * once): approval may post a fresh one in its place. If the reversal was
 * itself reversed the amounts are back in the ledger under another journal,
 * and a fresh one would book the month twice — that stays refused.
 */
const replaceable = (posted: PostedPayrollJournal | null): boolean =>
  posted != null && posted.reversedAt != null && posted.reversalStands;

function hashOf(plan: PayrollJournalPlan, replaces: PostedPayrollJournal | null): string {
  return createHash('sha256').update(JSON.stringify({
    status: plan.status,
    posted: replaces ? null : plan.alreadyPostedJournalId,
    replaces: replaces?.journalEntryId ?? null,
    lines: plan.lines.map((l) => [l.glAccountId, l.accountCode, cents(l.debit), cents(l.credit)]),
    totals: Object.entries(plan.totals).map(([k, v]) => [k, cents(v)]),
  })).digest('hex');
}

function judge(plan: PayrollJournalPlan, posted: PostedPayrollJournal | null): PayrollJournalNote | null {
  const statusRefusal = approvalStatusRefusal(plan.status, plan.alreadyPostedJournalId);
  if (statusRefusal) return { code: 'status_not_approvable', detail: statusRefusal };
  if (plan.alreadyPostedJournalId && !replaceable(posted)) {
    const state = !posted ? 'missing'
      : posted.reversedAt ? 'reversed, and its reversal was reversed in turn — its amounts are back in the ledger under another journal'
        : posted.status !== 'posted' ? `'${posted.status}'` : null;
    if (state || !posted) {
      return {
        code: 'posted_journal_not_live',
        detail: `The journal this run posted (${plan.alreadyPostedJournalId}) is ${state ?? 'missing'}, so the run can neither be re-approved onto it nor post a new one.`,
      };
    }
    if (!sameFigures(plan, posted)) {
      return {
        code: 'recalculated_after_posting',
        detail: 'This run was recalculated after its journal posted, so its figures no longer match that journal — reverse the posted journal first.',
      };
    }
    return null;
  }
  // Nothing posted, or a reversed journal to replace: the plan must be postable.
  // 'run_not_approved' is what approval resolves; 'already_posted' names the
  // reversed journal approval is about to unlink.
  return plan.blockers.find((b) => b.code !== 'run_not_approved' && b.code !== 'already_posted') ?? null;
}

/** Null when the run is not in this company. Read-only. */
export async function judgePayrollApproval(companyId: string, runId: string): Promise<PayrollApprovalGate | null> {
  const plan = await buildPayrollJournalPlan(companyId, runId);
  if (!plan) return null;
  const linked = plan.alreadyPostedJournalId ? await readPostedJournal(companyId, plan.alreadyPostedJournalId) : null;
  const replaces = linked && replaceable(linked) ? linked : null;
  return { plan, posted: replaces ? null : linked, replaces, blocker: judge(plan, linked), planHash: hashOf(plan, replaces) };
}
