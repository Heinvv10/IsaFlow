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

function mapRun(r: Row): CloseRun {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    fiscalPeriodId: String(r.fiscal_period_id),
    periodLabel: String(r.period_label),
    status: String(r.status) as CloseRunStatus,
    overallReadiness: r.overall_readiness == null ? null : String(r.overall_readiness),
    createdBy: String(r.created_by),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    completedAt: r.completed_at == null
      ? null
      : (r.completed_at instanceof Date ? r.completed_at.toISOString() : String(r.completed_at)),
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
    targetEntityType: r.target_entity_type == null ? null : String(r.target_entity_type),
    targetEntityId: r.target_entity_id == null ? null : String(r.target_entity_id),
    status: String(r.status) as ProposalStatus,
    decidedBy: r.decided_by == null ? null : String(r.decided_by),
    decidedAt: r.decided_at == null
      ? null
      : (r.decided_at instanceof Date ? r.decided_at.toISOString() : String(r.decided_at)),
    result: (r.result ?? null) as Record<string, unknown> | null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

// ── Actionable state ─────────────────────────────────────────────────────────

/** Draft journals dated inside the period — the drill-down for auto_post proposals. */
export async function fetchDraftJournals(
  companyId: string,
  startDate: string,
  endDate: string,
): Promise<DraftJournalRow[]> {
  const rows = (await sql`
    SELECT gje.id, gje.entry_number, gje.entry_date, gje.description,
           COALESCE(SUM(gjl.debit), 0) AS total_debit,
           COUNT(gjl.id) AS line_count
    FROM gl_journal_entries gje
    LEFT JOIN gl_journal_lines gjl ON gjl.journal_entry_id = gje.id
    WHERE gje.company_id = ${companyId}::UUID
      AND gje.status = 'draft'
      AND gje.entry_date >= ${startDate}::DATE
      AND gje.entry_date <= ${endDate}::DATE
    GROUP BY gje.id, gje.entry_number, gje.entry_date, gje.description
    ORDER BY gje.entry_date, gje.entry_number
  `) as Row[];
  return rows.map(r => ({
    id: String(r.id),
    entryNumber: String(r.entry_number),
    entryDate: fmtDate(r.entry_date),
    description: r.description == null ? '' : String(r.description),
    totalDebit: Number(r.total_debit) || 0,
    lineCount: Number(r.line_count) || 0,
  }));
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
 * Move a proposal from 'proposed' to a terminal state, but ONLY if it is still
 * 'proposed' — the WHERE guard makes concurrent double-decisions a no-op
 * (returns 0 rows) rather than a double-post. Returns the updated proposal, or
 * null if it was already decided.
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
