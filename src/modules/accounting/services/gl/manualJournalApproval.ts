/**
 * The manual-journal approval gate (R-035 PR6; Hein, 2026-10-06, decision 2:
 * journals gate the HUMAN-COMPOSED paths only).
 *
 * gl_journal_entries carries every system posting as well, and
 * postJournalEntry — the primitive behind them all, which also re-enters
 * itself for a late VAT claim — stays ungated: a rule like "every journal needs
 * an accountant" there would stop invoice, payment, payroll and depreciation
 * postings. Instead each human-composed entry point calls this module, and
 * manualJournalApprovalCensus.test.ts pins every caller of postJournalEntry as
 * gated or exempt (with the reason):
 *
 *   - a person posting a draft (UI journal-entries-action, MCP post_journal):
 *     gated under the journal's row lock, before any write. ANY draft — a person
 *     choosing to post is the controlled act, whatever created the draft;
 *   - the creators nobody watches at the moment they run (receipt-to-journal
 *     autoPost, GL import with post-immediately, the recurring journal and
 *     recurring-transaction runs): they decide from the amount BEFORE writing
 *     whether the journal will be held, then leave it a draft and raise the
 *     request as the person who ran them — never refusing after a write;
 *   - an agent creating and posting in one call (MCP reclassification): refused
 *     up front, from reads, since it may neither raise nor decide (Q6).
 *
 * The marker (gl_journal_entries.approval_document_type, migration 869) is
 * written on the journals these paths create or post — ONLY while
 * manual_journal enforcement is on, so with it off no statement here names an
 * 869 column (golden path g runs on a database without 869). Once written,
 * migration 869's backstop refuses a raw status flip of the journal without a
 * cleared approval, and refuses removing the marker.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { isEnforced } from './approvalEnforcement';
import { assertApprovalCleared } from './approvalGate';
import { strictestMatchingRule } from './approvalMatching';
import { agentApprovalRefusal, raiseUnattendedApproval } from './approvalUnattended';

const TYPE = 'manual_journal' as const;

/** What a rule sees for a journal not yet written: its larger side (approval_manual_journal_gate_amount's twin). */
export function journalGateAmount(lines: readonly { debit?: number | null; credit?: number | null }[]): number {
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    debit += Math.abs(Number(l.debit ?? 0));
    credit += Math.abs(Number(l.credit ?? 0));
  }
  return Math.max(debit, credit);
}

/**
 * Lock the journal's row when manual_journal enforcement is on, so the gate
 * and the post that follows read one state; answers whether it is on. Off, it
 * reads approval_enforcement once and locks nothing (postJournalEntry takes
 * its own lock, as it always has).
 */
export async function lockManualJournalIfEnforced(companyId: string, id: string): Promise<boolean> {
  if (!(await isEnforced(companyId, TYPE))) return false;
  await sql`SELECT id FROM gl_journal_entries WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID FOR UPDATE`;
  return true;
}

/**
 * A person posting a journal. Under enforcement, a DRAFT the gate does not
 * clear throws ApprovalRequiredError (the route's 409) — under the row lock and
 * before any write, so the COMMIT withAuth issues on a 4xx commits nothing. A
 * journal that is not a draft is left to postJournalEntry's own refusal.
 * Answers whether enforcement is on: the caller then marks the journal in the
 * same savepoint as its post.
 */
export async function gateManualJournalPost(companyId: string, id: string): Promise<boolean> {
  if (!(await lockManualJournalIfEnforced(companyId, id))) return false;
  const [row] = (await sql`
    SELECT status FROM gl_journal_entries WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (row?.status === 'draft') await assertApprovalCleared(companyId, TYPE, id);
  return true;
}

/**
 * Write the marker. Only for a caller that established enforcement is on —
 * this statement names the 869 column. An already-marked journal is left as
 * it is (the backstop refuses changing a marker).
 */
export async function markManualJournal(companyId: string, id: string): Promise<void> {
  await sql`
    UPDATE gl_journal_entries SET approval_document_type = 'manual_journal'
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND approval_document_type IS NULL
  `;
}

/** Whether an unattended creator's new journal will be held, decided before it writes anything. */
export interface NewJournalGate {
  enforced: boolean;
  held: boolean;
}

/**
 * Decide, from reads, whether a journal of these lines will be held: enforcement
 * is on and an active rule matches its amount. A journal not yet written has no
 * approval, so a matching rule always holds it.
 */
export async function newManualJournalGate(companyId: string,
  lines: readonly { debit?: number | null; credit?: number | null }[]): Promise<NewJournalGate> {
  if (!(await isEnforced(companyId, TYPE))) return { enforced: false, held: false };
  return { enforced: true, held: (await strictestMatchingRule(companyId, TYPE, journalGateAmount(lines))) !== null };
}

/**
 * After an unattended creator has written its draft: under enforcement, mark
 * it and union in its upstream authors (a recurring template's), then — when
 * held — raise the request as `runBy`, the person who ran it (nothing is raised
 * under Login-as: the draft keeps showing Submit). The caller posts only when
 * `gate.held` is false. Never refuses: the draft and its request are the
 * consistent state a hold leaves.
 */
export async function settleUnattendedJournal(companyId: string, entryId: string, runBy: string,
  gate: NewJournalGate, upstreamAuthors: readonly string[] = []): Promise<void> {
  if (!gate.enforced) return;
  await markManualJournal(companyId, entryId);
  if (upstreamAuthors.length > 0) {
    await sql`
      UPDATE gl_journal_entries
      SET content_authors = content_authors || ARRAY(
        SELECT DISTINCT a FROM unnest(${[...upstreamAuthors]}::UUID[]) a WHERE a <> ALL(content_authors) ORDER BY a)
      WHERE id = ${entryId}::UUID AND company_id = ${companyId}::UUID
    `;
  }
  if (gate.held) await raiseUnattendedApproval(companyId, TYPE, entryId, runBy);
}

/** An agent posting an existing draft (MCP post_journal): the refusal text, or null when the gate clears it. */
export async function agentManualJournalRefusal(companyId: string, id: string): Promise<string | null> {
  return agentApprovalRefusal(companyId, TYPE, id);
}

/**
 * An agent about to CREATE and POST journals in one call (MCP
 * post_reclassification_batch). No draft survives it, and the agent may
 * neither raise nor decide (Q6), so the whole call is refused up front, from
 * reads, when manual journals are enforced and an active rule matches any
 * journal it would post.
 */
export async function agentNewManualJournalsRefusal(companyId: string,
  journals: readonly (readonly { debit?: number | null; credit?: number | null }[])[]): Promise<string | null> {
  if (!(await isEnforced(companyId, TYPE))) return null;
  for (const lines of journals) {
    const amount = journalGateAmount(lines);
    const rule = await strictestMatchingRule(companyId, TYPE, amount);
    if (!rule) continue;
    return `Manual journals are enforced: a journal of R${amount.toFixed(2)} needs ${rule.approverRole} approval before it `
      + `can be posted (rule: ${rule.name}). This connector cannot raise or decide approvals: a person must post the `
      + 'journals in IsaFlow, submit them for approval, and an eligible approver must approve them.';
  }
  return null;
}
