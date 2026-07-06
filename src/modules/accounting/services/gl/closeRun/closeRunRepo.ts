/**
 * Close Agent v1 — persistence layer (company-scoped, multi-tenant safe).
 *
 * Every query filters by company_id. The service layer composes these with the
 * pure builder, the readiness service, the posting service and the audit trail.
 */

import { sql, fmtDate } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type {
  CloseRun,
  CloseProposal,
  CloseRunWithProposals,
  CloseRunStatus,
  ProposalDraft,
  ProposalStatus,
  ProposalOutcomeCounts,
  DraftJournalRow,
} from './closeRunTypes';

type Row = DbRow;

// ── Mappers ──────────────────────────────────────────────────────────────────

/** pg timestamptz comes back as Date OR string — normalise to ISO (or null). */
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

function mapRun(r: Row): CloseRun {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    fiscalPeriodId: String(r.fiscal_period_id),
    periodLabel: String(r.period_label),
    status: String(r.status) as CloseRunStatus,
    overallReadiness: strOrNull(r.overall_readiness),
    createdBy: String(r.created_by),
    createdAt: iso(r.created_at),
    completedAt: isoOrNull(r.completed_at),
  };
}

function mapProposal(r: Row): CloseProposal {
  const ev = (r.evidence ?? {}) as CloseProposal['evidence'];
  return {
    id: String(r.id),
    closeRunId: String(r.close_run_id),
    kind: String(r.kind) as CloseProposal['kind'],
    actionType: String(r.action_type) as CloseProposal['actionType'],
    title: String(r.title),
    reasoning: String(r.reasoning),
    evidence: typeof ev === 'object' && ev !== null ? ev : { summary: '' },
    targetEntityType: strOrNull(r.target_entity_type),
    targetEntityId: strOrNull(r.target_entity_id),
    status: String(r.status) as ProposalStatus,
    decidedBy: strOrNull(r.decided_by),
    decidedAt: isoOrNull(r.decided_at),
    result: (r.result ?? null) as Record<string, unknown> | null,
    createdAt: iso(r.created_at),
  };
}

// ── Actionable state ─────────────────────────────────────────────────────────

/**
 * Draft journals in the period — the drill-down for auto_post proposals. Keyed on
 * fiscal_period_id (NOT entry_date) to match the readiness unpostedJournalsCheck.
 */
export async function fetchDraftJournals(
  companyId: string,
  fiscalPeriodId: string,
): Promise<DraftJournalRow[]> {
  const rows = (await sql`
    SELECT gje.id, gje.entry_number, gje.entry_date, gje.description,
           COALESCE(SUM(gjl.debit), 0) AS total_debit,
           COALESCE(SUM(gjl.credit), 0) AS total_credit,
           COUNT(gjl.id) AS line_count
    FROM gl_journal_entries gje
    LEFT JOIN gl_journal_lines gjl ON gjl.journal_entry_id = gje.id
    WHERE gje.company_id = ${companyId}::UUID
      AND gje.status = 'draft'
      AND gje.fiscal_period_id = ${fiscalPeriodId}::UUID
    GROUP BY gje.id, gje.entry_number, gje.entry_date, gje.description
    ORDER BY gje.entry_date, gje.entry_number
  `) as Row[];
  return rows.map(r => ({
    id: String(r.id),
    entryNumber: String(r.entry_number),
    entryDate: fmtDate(r.entry_date),
    description: r.description == null ? '' : String(r.description),
    totalDebit: Number(r.total_debit) || 0,
    totalCredit: Number(r.total_credit) || 0,
    lineCount: Number(r.line_count) || 0,
  }));
}

/**
 * The readiness unpostedJournalsCheck's own tally — journal entries in the
 * period that are not yet posted (draft, pending, …). The builder uses this to
 * decide whether every unposted entry was drilled into a postable proposal.
 */
export async function countUnpostedInPeriod(
  companyId: string,
  fiscalPeriodId: string,
): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*) AS cnt
    FROM gl_journal_entries
    WHERE company_id = ${companyId}::UUID
      AND fiscal_period_id = ${fiscalPeriodId}::UUID
      AND status != 'posted'
  `) as Row[];
  return Number(rows[0]?.cnt) || 0;
}

// ── Writes ───────────────────────────────────────────────────────────────────

export async function insertCloseRun(
  companyId: string,
  fiscalPeriodId: string,
  periodLabel: string,
  overallReadiness: string | null,
  userId: string,
): Promise<CloseRun> {
  const rows = (await sql`
    INSERT INTO close_runs (company_id, fiscal_period_id, period_label, overall_readiness, created_by)
    VALUES (${companyId}::UUID, ${fiscalPeriodId}::UUID, ${periodLabel}, ${overallReadiness}, ${userId}::UUID)
    RETURNING *
  `) as Row[];
  return mapRun(rows[0]!);
}

export async function insertProposals(
  companyId: string,
  closeRunId: string,
  drafts: ProposalDraft[],
): Promise<CloseProposal[]> {
  const out: CloseProposal[] = [];
  for (const d of drafts) {
    const rows = (await sql`
      INSERT INTO close_run_proposals (
        company_id, close_run_id, kind, action_type, title, reasoning, evidence,
        target_entity_type, target_entity_id
      ) VALUES (
        ${companyId}::UUID, ${closeRunId}::UUID, ${d.kind}, ${d.actionType}, ${d.title},
        ${d.reasoning}, ${JSON.stringify(d.evidence)}::JSONB,
        ${d.targetEntityType}, ${d.targetEntityId == null ? null : d.targetEntityId}::UUID
      )
      RETURNING *
    `) as Row[];
    out.push(mapProposal(rows[0]!));
  }
  return out;
}

/**
 * Move a proposal out of 'proposed' — the `status='proposed'` WHERE guard makes
 * concurrent double-decisions a no-op (null), not a double-post.
 */
export async function updateProposalOutcome(
  companyId: string,
  proposalId: string,
  status: ProposalStatus,
  decidedBy: string,
  result: Record<string, unknown> | null,
): Promise<CloseProposal | null> {
  const rows = (await sql`
    UPDATE close_run_proposals
    SET status = ${status}, decided_by = ${decidedBy}::UUID, decided_at = NOW(),
        result = ${result == null ? null : JSON.stringify(result)}::JSONB
    WHERE id = ${proposalId}::UUID AND company_id = ${companyId}::UUID AND status = 'proposed'
    RETURNING *
  `) as Row[];
  return rows.length === 0 ? null : mapProposal(rows[0]!);
}

/** Advance a proposal this request CLAIMED (status='approved') to its terminal state. */
export async function finalizeClaimedProposal(
  companyId: string,
  proposalId: string,
  status: ProposalStatus,
  result: Record<string, unknown> | null,
): Promise<CloseProposal | null> {
  const rows = (await sql`
    UPDATE close_run_proposals
    SET status = ${status},
        result = ${result == null ? null : JSON.stringify(result)}::JSONB
    WHERE id = ${proposalId}::UUID AND company_id = ${companyId}::UUID AND status = 'approved'
    RETURNING *
  `) as Row[];
  return rows.length === 0 ? null : mapProposal(rows[0]!);
}

/** Abandon any still-open run for a period — one open run per period at a time. */
export async function abandonOpenRunsForPeriod(
  companyId: string,
  fiscalPeriodId: string,
): Promise<void> {
  await sql`
    UPDATE close_runs SET status = 'abandoned'
    WHERE company_id = ${companyId}::UUID
      AND fiscal_period_id = ${fiscalPeriodId}::UUID
      AND status = 'open'
  `;
}

export async function updateCloseRunStatus(
  companyId: string,
  runId: string,
  status: CloseRunStatus,
): Promise<void> {
  // completed_at is stamped only on completion; other transitions leave it untouched.
  if (status === 'completed') {
    await sql`
      UPDATE close_runs SET status = ${status}, completed_at = NOW()
      WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID
    `;
  } else {
    await sql`
      UPDATE close_runs SET status = ${status}
      WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID
    `;
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function loadProposals(companyId: string, runId: string): Promise<CloseProposal[]> {
  const rows = (await sql`
    SELECT * FROM close_run_proposals
    WHERE close_run_id = ${runId}::UUID AND company_id = ${companyId}::UUID
    ORDER BY
      CASE action_type WHEN 'auto_post' THEN 0 ELSE 1 END,
      created_at
  `) as Row[];
  return rows.map(mapProposal);
}

export async function getCloseRunById(
  companyId: string,
  runId: string,
): Promise<CloseRunWithProposals | null> {
  const rows = (await sql`
    SELECT * FROM close_runs WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];
  if (rows.length === 0) return null;
  const run = mapRun(rows[0]!);
  return { run, proposals: await loadProposals(companyId, run.id) };
}

export async function getLatestCloseRunForPeriod(
  companyId: string,
  fiscalPeriodId: string,
): Promise<CloseRunWithProposals | null> {
  const rows = (await sql`
    SELECT * FROM close_runs
    WHERE company_id = ${companyId}::UUID AND fiscal_period_id = ${fiscalPeriodId}::UUID
    ORDER BY created_at DESC
    LIMIT 1
  `) as Row[];
  if (rows.length === 0) return null;
  const run = mapRun(rows[0]!);
  return { run, proposals: await loadProposals(companyId, run.id) };
}

export async function getProposalById(
  companyId: string,
  proposalId: string,
): Promise<CloseProposal | null> {
  const rows = (await sql`
    SELECT * FROM close_run_proposals
    WHERE id = ${proposalId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];
  return rows.length === 0 ? null : mapProposal(rows[0]!);
}

/** Company-wide proposal outcome tallies for the accuracy panel. */
export async function getOutcomeCounts(companyId: string): Promise<ProposalOutcomeCounts> {
  const rows = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE action_type = 'auto_post') AS proposed,
      COUNT(*) FILTER (WHERE action_type = 'auto_post' AND status = 'approved') AS approved,
      COUNT(*) FILTER (WHERE action_type = 'auto_post' AND status = 'posted')   AS posted,
      COUNT(*) FILTER (WHERE action_type = 'auto_post' AND status = 'rejected') AS rejected,
      COUNT(*) FILTER (WHERE action_type = 'auto_post' AND status = 'failed')   AS failed,
      COUNT(*) FILTER (WHERE status = 'dismissed') AS dismissed
    FROM close_run_proposals
    WHERE company_id = ${companyId}::UUID
  `) as Row[];
  const r = rows[0]!;
  return {
    proposed: Number(r.proposed) || 0,
    approved: Number(r.approved) || 0,
    posted: Number(r.posted) || 0,
    rejected: Number(r.rejected) || 0,
    failed: Number(r.failed) || 0,
    dismissed: Number(r.dismissed) || 0,
  };
}
