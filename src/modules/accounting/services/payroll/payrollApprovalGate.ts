/**
 * The approval gate — ONE judgement of whether a pay run may be approved,
 * used by approvePayrollRun (live) and by previewPayrollApproval (the run
 * page's confirmation and the MCP dry run), so none of them can greenlight
 * what another refuses (W3-01 review).
 *
 * In order:
 *   1. status: draft / calculated / processed, or approved with no journal; then a run calculated by an older
 *      calculation (`recalculate_required`), and after the directive and year-to-date checks, component dates changed
 *      since calculation or a leaver with no termination base (payrollRunRecalcGate) — for every approval;
 *   1a. severance lines whose SARS directive was paid by something else, or no
 *      longer matches them (`severance_directive_unavailable`, audit
 *      2026-10-18 P3, payrollRunDirectiveClaim) — re-checked under the
 *      directive's row lock when approval claims it;
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
 *      already paid (`termination_already_paid`, audit 2026-10-18 P4), then a
 *      recurring row needing a manual pro-rata (`recurring_needs_pro_rata`,
 *      payrollRecurringProRata), then every journal-plan blocker except
 *      'run_not_approved', which approval itself resolves, and
 *      'already_posted', which names the journal being replaced.
 *
 * `planHash` fingerprints what approval would do: which run, the journal's
 * date and description, its lines (account, CC1, amounts) and totals, and the
 * journal it would re-lock onto or replace. The caller sends the hash it previewed and
 * approval refuses (409) when the run no longer hashes the same.
 */
import { createHash } from 'crypto';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { approvalStatusRefusal } from './payrollApprovalRefusal';
import { closedPeriodBlocker } from './payrollJournalParts';
import { comparableLines, predatesTagging, sameFigures, type FigureLine } from './payrollLabourComparison';
import { readJournalChain, runRecalculatedSince, type JournalChain } from './payrollJournalChain';
import { judgeRunDirectives, unpaidLeaverDirectiveNotes } from './payrollRunDirectiveClaim';
import { judgeYearToDate } from './payrollYearToDateGate';
import { findTerminationsPaidElsewhere } from './payrollTerminationPaidCheck';
import { runProRataBlocker } from './payrollRecurringProRata';
import { recalculateRequiredRefusal, runLinesRefusal } from './payrollRunRecalcGate';
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
  lines: Array<{ glAccountId: string; accountCode: string; accountName: string; debit: number; credit: number; cc1Id: string | null }>;
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
 * raise). Nothing reads it from the response, so it is not sent; nor is
 * `labourBySourceCentre`, the gate's internal comparison breakdown.
 */
export type JournalPlanPreview = Omit<PayrollApprovalGate, 'plan'> & { plan: Omit<PayrollJournalPlan, 'blockers' | 'labourBySourceCentre'> };

/** The preview as the route sends it: the gate without the plan's raw blocker list. Hash and `blocker` are unchanged. */
export function toJournalPlanPreview(gate: PayrollApprovalGate): JournalPlanPreview {
  const { blockers: _raw, labourBySourceCentre: _internal, ...plan } = gate.plan;
  return { ...gate, plan };
}

const cents = (n: number): number => Math.round(n * 100);
/** An as-posted CC1 the tag history cannot tell (see readPostedJournal); never a centre id, so no plan matches it. */
const AMBIGUOUS_TAG = 'ambiguous-tag-history';

/**
 * The journal, and its lines AS POSTED for the gate's comparison (`asPosted`,
 * internal): a CC1 the tag tool (tag_journal_lines) changed since is read back
 * from the line's first tag batch's `old_cc1_id` — re-tagging the ledger is not
 * the run changing, and a tag cleared that way must not make a tagged journal
 * read as one from before CC1 (PR #1065 review round 2, M2). The tag tool is
 * the only writer of a posted line's CC1 (dimensionTagApply; its batch
 * reversal restores the old value).
 *
 * FAIL CLOSED on an unreadable history (round 3, T1): when the line's earliest
 * tag rows are more than one — two batches of one transaction share created_at
 * (an MCP JSON-RPC batch runs in one), or one batch lists the line twice
 * (planDimensionTags refuses that, nothing else would) — which CC1 it was
 * posted with cannot be told; a random batch id must not decide it. The line
 * then reads as `AMBIGUOUS_TAG`, a CC1 no plan carries, so a recalculated run
 * is refused as `recalculated_after_posting` (reverse, approve: a fresh one).
 */
async function readPostedJournal(companyId: string, journalId: string): Promise<{ journal: PostedPayrollJournal; asPosted: FigureLine[] } | null> {
  const rows = (await sql`
    SELECT e.entry_number, e.status, e.reversed_at, l.gl_account_id, a.account_code, a.account_name,
           l.debit::float8 AS debit, l.credit::float8 AS credit, l.cc1_id,
           (first_tag.journal_line_id IS NOT NULL) AS retagged, first_tag.old_cc1_id, first_tag.tied::int AS tied, l.id AS line_id
    FROM gl_journal_entries e
    LEFT JOIN gl_journal_lines l ON l.journal_entry_id = e.id AND l.company_id = e.company_id
    LEFT JOIN gl_accounts a ON a.id = l.gl_account_id AND a.company_id = e.company_id
    LEFT JOIN LATERAL (
      SELECT bl.journal_line_id, bl.old_cc1_id, count(*) OVER (PARTITION BY b.created_at) AS tied
        FROM dimension_tag_batch_lines bl
        JOIN dimension_tag_batches b ON b.id = bl.batch_id AND b.company_id = bl.company_id
       WHERE bl.journal_line_id = l.id AND bl.company_id = e.company_id
       ORDER BY b.created_at, b.id LIMIT 1
    ) first_tag ON true
    WHERE e.id = ${journalId}::uuid AND e.company_id = ${companyId}::uuid
    ORDER BY l.debit DESC, a.account_code, l.id
  `) as DbRow[];
  const head = rows[0];
  if (!head) return null;
  const id = (v: unknown): string | null => (v == null ? null : String(v));
  const asPosted = rows.filter((r) => r.gl_account_id != null).map((r): FigureLine => ({
    glAccountId: String(r.gl_account_id),
    debit: Number(r.debit) || 0,
    credit: Number(r.credit) || 0,
    cc1Id: r.retagged !== true ? id(r.cc1_id) : Number(r.tied) > 1 ? `${AMBIGUOUS_TAG}:${String(r.line_id)}` : id(r.old_cc1_id),
  }));
  const lines = rows.filter((r) => r.gl_account_id != null).map((r) => ({
    glAccountId: String(r.gl_account_id),
    accountCode: String(r.account_code ?? ''),
    accountName: String(r.account_name ?? ''),
    debit: Number(r.debit) || 0,
    credit: Number(r.credit) || 0,
    cc1Id: r.cc1_id == null ? null : String(r.cc1_id),
  }));
  const journal = {
    journalEntryId: journalId,
    entryNumber: String(head.entry_number ?? ''),
    status: String(head.status),
    reversedAt: head.reversed_at == null ? null : new Date(head.reversed_at as string | Date).toISOString(),
    lines,
    totalDebit: cents(lines.reduce((s, l) => s + l.debit, 0)) / 100,
    totalCredit: cents(lines.reduce((s, l) => s + l.credit, 0)) / 100,
  };
  return { journal, asPosted };
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
    // CC1 is in it: it changes what posts, so a preview taken before a centre moved cannot approve the new split.
    lines: plan.lines.map((l) => [l.glAccountId, l.accountCode, l.cc1Id, cents(l.debit), cents(l.credit)]),
    totals: Object.entries(plan.totals).map(([k, v]) => [k, cents(v)]),
  })).digest('hex');
}

/** Null when the run is not in this company. Read-only. */
export async function judgePayrollApproval(companyId: string, runId: string): Promise<PayrollApprovalGate | null> {
  const built = await buildPayrollJournalPlan(companyId, runId);
  if (!built) return null;
  const linkedId = built.alreadyPostedJournalId;
  const chain = linkedId ? await readJournalChain(companyId, linkedId) : null;
  const read = linkedId ? await readPostedJournal(companyId, linkedId) : null;
  const linked = read?.journal ?? null;
  const out = chain?.state === 'out';
  const replaces = out ? linked : null;
  const posted = out ? null : linked;
  const dated = out && chain ? await datedForReplacement(companyId, built, chain) : built;
  // Cumulative PAYE read a year-to-date that is no longer what the other months declare (G4, round 2 R1).
  // Judged here, before the blocker below, because its advisories belong in the plan: one more read-only
  // query on every judgement, run before the status and directive checks under the same locks. Its
  // blocker is still returned only after theirs, so blocker precedence is unchanged.
  const yearToDate = await judgeYearToDate(companyId, runId);
  // Leavers whose approved severance directive this run does not pay, and why (P3), and a paid later month
  // this run's change leaves stale (R1 limit (f)); neither is in the hash.
  const plan = {
    ...dated,
    advisories: [...dated.advisories, ...await unpaidLeaverDirectiveNotes(companyId, runId), ...yearToDate.advisories],
  };

  const blocker = await (async (): Promise<PayrollJournalNote | null> => {
    const statusRefusal = approvalStatusRefusal(plan.status, linkedId);
    if (statusRefusal) return { code: 'status_not_approvable', detail: statusRefusal };
    // Calculated by an older calculation (no stamp, migration 953): recalculate first (payrollRunRecalcGate).
    const stale = await recalculateRequiredRefusal(companyId, runId);
    if (stale) return stale;
    // Severance lines whose directive another payer took, or that no longer match it (P3).
    const directives = await judgeRunDirectives(companyId, runId);
    if (directives) return directives;
    if (yearToDate.blocker) return yearToDate.blocker;
    // Component dates changed since calculation; a leaver with no termination base (payrollRunRecalcGate). Also for a
    // re-approval onto a journal in force.
    const lines = await runLinesRefusal(companyId, runId);
    if (lines) return lines;
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
      const perAccount = await runRecalculatedSince(companyId, runId, linkedId);
      const compared = perAccount
        ? comparableLines(plan.lines, plan.labourBySourceCentre, read!.asPosted)
        : { plan: plan.lines, posted: linked.lines };
      if (!sameFigures(compared, perAccount)) {
        const cause = perAccount && predatesTagging(plan.lines, read!.asPosted)
          ? 'the journal predates cost-centre tagging and this run now tags its labour by cost centre'
          : 'it was recalculated, or its pay moved between cost centres, after posting';
        return {
          code: 'recalculated_after_posting',
          detail: `This run's figures no longer match the journal it posted (${numbers}) — ${cause}. `
            + `Reverse journal ${inForce.entryNumber} first; approving then posts a new one.`,
        };
      }
      return null;
    }
    // Nothing posted, or a journal to replace: the plan must be postable.
    const paidTwice = await findTerminationsPaidElsewhere(companyId, runId);
    if (paidTwice.length > 0) {
      return {
        code: 'termination_already_paid',
        detail: 'Termination pay-outs on this run were already paid in another run (approved, or reopened with its journal posted): '
          + paidTwice.map(p => `${p.employeeNumber} (${p.year}-${String(p.month).padStart(2, '0')})`).join(', ')
          + '. Recalculate this run first; it then leaves them out.',
      };
    }
    // A recurring row the last-day read pays in full or drops, unresolved (payrollRecurringProRata).
    const proRata = await runProRataBlocker(companyId, runId);
    if (proRata) return proRata;
    return plan.blockers.find((b) => b.code !== 'run_not_approved' && b.code !== 'already_posted') ?? null;
  })();

  return { plan, posted, replaces, blocker, planHash: hashOf(plan, posted, replaces) };
}
