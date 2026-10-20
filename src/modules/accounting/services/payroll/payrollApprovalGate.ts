/**
 * The approval gate — ONE judgement of whether a pay run may be approved,
 * used by approvePayrollRun (live) and by previewPayrollApproval (the run
 * page's confirmation and the MCP dry run), so none of them can greenlight
 * what another refuses (W3-01 review).
 *
 * In order:
 *   1. status: draft / calculated / processed, or approved with no journal;
 *   2. a run that links a journal (reopen keeps `journal_entry_id`) is judged
 *      by what that journal's reversal chain leaves in the LEDGER
 *      (payrollJournalChain) — never by `reversed_at`, which says only that a
 *      chain exists:
 *        in force → the run is re-approved onto it, posting nothing, but only
 *                   while its figures match what the run would post now
 *                   (`sameFigures`), else `recalculated_after_posting`;
 *        out      → nothing of the run is in the ledger: approval unlinks the
 *                   journal and posts a FRESH one (`replaces`), dated by
 *                   `datedForReplacement`;
 *        unclear  → refused, naming the journals (`posted_journal_not_live`);
 *   3. for a fresh journal, termination pay-outs another approved or paid run
 *      already paid (`termination_already_paid`, audit 2026-10-18 P4), then
 *      every journal-plan blocker except
 *      'run_not_approved', which approval itself resolves, and
 *      'already_posted', which names the journal being replaced.
 *
 * `planHash` fingerprints what approval would do: which run, the journal's
 * date and description, its lines and totals, and the journal it would
 * re-lock onto or replace. The caller sends the hash it previewed and
 * approval refuses (409) when the run no longer hashes the same.
 */
import { createHash } from 'crypto';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { approvalStatusRefusal } from './payrollApprovalRefusal';
import { closedPeriodBlocker } from './payrollJournalParts';
import { readJournalChain, runRecalculatedSince, type JournalChain } from './payrollJournalChain';
import { findTerminationsPaidElsewhere } from './payrollTerminationService';
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
  /** The journal the run links, when its amounts are in the ledger. Approval posts nothing new onto it. */
  posted: PostedPayrollJournal | null;
  /** The journal the run links, when nothing of it is in the ledger. Approval unlinks it and posts a fresh one. `posted` is then null. */
  replaces: PostedPayrollJournal | null;
  blocker: PayrollJournalNote | null;
  planHash: string;
}

/**
 * What GET …/journal-plan returns. The plan's own `blockers` list is the poster's
 * raw view: it still holds run_not_approved and already_posted, which approving
 * resolves, so it disagrees with `blocker` (the one refusal approval would
 * raise). Nothing reads it from the response, so it is not sent.
 */
export type JournalPlanPreview = Omit<PayrollApprovalGate, 'plan'> & { plan: Omit<PayrollJournalPlan, 'blockers'> };

/** The preview as the route sends it: the gate without the plan's raw blocker list. Hash and `blocker` are unchanged. */
export function toJournalPlanPreview(gate: PayrollApprovalGate): JournalPlanPreview {
  const { blockers: _raw, ...plan } = gate.plan;
  return { ...gate, plan };
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

/**
 * What must agree between the run's plan and the journal in force, in cents:
 * every credit by GL account (PAYE, UIF, SDL, deductions, net pay — each a
 * header total), and the labour debit.
 *
 * Labour is ONE total for a run that has not been recalculated since the
 * journal posted. Its split across cost-centre accounts then follows today's
 * cost centres, mappings and allocations (and, before the split's reads were
 * ordered, the heap's order for its rounding cent) — none of which is the run
 * changing, and a journal is not wrong for carrying the split of its day
 * (breaker B, C).
 *
 * Labour is PER ACCOUNT once the run HAS been recalculated since
 * (`perAccount`). A recalculation can move pay between employees in different
 * cost centres and leave every header total as it was; the split is then the
 * only place the change shows, and it is a real figure on a real expense
 * account (breaker C4).
 */
function figures(
  lines: Array<{ glAccountId: string | null; debit: number; credit: number }>,
  perAccount: boolean,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) {
    const k = cents(l.debit) !== 0 && !perAccount ? 'labour' : l.glAccountId ?? 'missing';
    m.set(k, (m.get(k) ?? 0) + cents(l.debit) - cents(l.credit));
  }
  for (const [k, v] of m) if (v === 0) m.delete(k);
  return m;
}

function sameFigures(plan: PayrollJournalPlan, posted: PostedPayrollJournal, perAccount: boolean): boolean {
  const a = figures(plan.lines, perAccount);
  const b = figures(posted.lines, perAccount);
  return a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
}

/**
 * The plan for a journal that REPLACES a reversed one.
 *
 * ACCOUNTING RULING NEEDED (W3-01 round 5, C1-E) — implemented as recommended,
 * pending the owner's decision. When the reversal that took the old journal
 * out is not dated in the run's month (the month was closed, so the reversal
 * fell on a later date), the replacement is dated ON THAT REVERSAL'S DATE. The
 * reversal and the replacement then net in one period, and the run's own month
 * keeps the figures it reported. Dated in the run's month instead, that month
 * would carry the run twice and the later one a negative.
 * The alternative — re-date into the original month — needs that period
 * reopened and the reversal moved into it; it is not done here.
 */
async function datedForReplacement(companyId: string, plan: PayrollJournalPlan, chain: JournalChain): Promise<PayrollJournalPlan> {
  const reversal = chain.journals[chain.journals.length - 1];
  if (!reversal || chain.journals.length < 2 || reversal.entryDate.slice(0, 7) === plan.entryDate.slice(0, 7)) return plan;
  const closed = await closedPeriodBlocker(companyId, reversal.entryDate);
  return {
    ...plan,
    entryDate: reversal.entryDate,
    blockers: [...plan.blockers.filter((b) => b.code !== 'closed_period'), ...(closed ? [closed] : [])],
    advisories: [...plan.advisories, {
      code: 'replacement_dated_on_reversal',
      detail: `The journal this run posted was reversed by ${reversal.entryNumber} on ${reversal.entryDate}, outside ${plan.entryDate.slice(0, 7)}. `
        + `The new journal is dated ${reversal.entryDate} as well, so the reversal and the new journal fall in the same period and `
        + `${plan.entryDate.slice(0, 7)} keeps the figures it reported.`,
    }],
  };
}

function hashOf(plan: PayrollJournalPlan, posted: PostedPayrollJournal | null, replaces: PostedPayrollJournal | null): string {
  return createHash('sha256').update(JSON.stringify({
    run: plan.runId,
    status: plan.status,
    entryDate: plan.entryDate,
    description: plan.description,
    posted: posted?.journalEntryId ?? null,
    replaces: replaces?.journalEntryId ?? null,
    lines: plan.lines.map((l) => [l.glAccountId, l.accountCode, cents(l.debit), cents(l.credit)]),
    totals: Object.entries(plan.totals).map(([k, v]) => [k, cents(v)]),
  })).digest('hex');
}

/** Null when the run is not in this company. Read-only. */
export async function judgePayrollApproval(companyId: string, runId: string): Promise<PayrollApprovalGate | null> {
  const built = await buildPayrollJournalPlan(companyId, runId);
  if (!built) return null;
  const linkedId = built.alreadyPostedJournalId;
  const chain = linkedId ? await readJournalChain(companyId, linkedId) : null;
  const linked = linkedId ? await readPostedJournal(companyId, linkedId) : null;
  const out = chain?.state === 'out';
  const replaces = out ? linked : null;
  const posted = out ? null : linked;
  const plan = out && chain ? await datedForReplacement(companyId, built, chain) : built;

  const blocker = await (async (): Promise<PayrollJournalNote | null> => {
    const statusRefusal = approvalStatusRefusal(plan.status, linkedId);
    if (statusRefusal) return { code: 'status_not_approvable', detail: statusRefusal };
    if (linkedId && !out) {
      const numbers = chain?.journals.map((j) => j.entryNumber).join(', ');
      if (!chain || !linked || chain.state === 'unclear') {
        return {
          code: 'posted_journal_not_live',
          detail: !chain || !linked
            ? `The journal this run posted (${linkedId}) is missing, so the run can neither be re-approved onto it nor post a new one.`
            : chain.broken
              ? `The reversal links of the journal this run posted do not form a chain that ends (${numbers}) — they loop, or are too many to follow — `
                + 'so the run can neither be re-approved onto it nor post a new one. The links need correcting first.'
              : `The journal this run posted and its reversals (${numbers}) leave neither that journal nor nothing in the ledger `
                + '(one of them is unposted, or they do not mirror each other), so the run can neither be re-approved onto it nor post a new one.',
        };
      }
      // In force. The journal to reverse is the LAST of the chain: the run's own, or the one that re-booked it.
      const inForce = chain.journals[chain.journals.length - 1]!;
      if (!sameFigures(plan, linked, await runRecalculatedSince(companyId, runId, linkedId))) {
        return {
          code: 'recalculated_after_posting',
          detail: `This run's figures no longer match the journal it posted (${numbers}) — it was recalculated, or its pay moved between `
            + `cost centres, after posting. Reverse journal ${inForce.entryNumber} first; approving then posts a new one.`,
        };
      }
      return null;
    }
    // Nothing posted, or a journal to replace: the plan must be postable.
    const paidTwice = await findTerminationsPaidElsewhere(companyId, runId);
    if (paidTwice.length > 0) {
      return {
        code: 'termination_already_paid',
        detail: 'Termination pay-outs on this run were already paid in an approved run: '
          + paidTwice.map(p => `${p.employeeNumber} (${p.year}-${String(p.month).padStart(2, '0')})`).join(', ')
          + '. Recalculate this run first; it then leaves them out.',
      };
    }
    return plan.blockers.find((b) => b.code !== 'run_not_approved' && b.code !== 'already_posted') ?? null;
  })();

  return { plan, posted, replaces, blocker, planHash: hashOf(plan, posted, replaces) };
}
