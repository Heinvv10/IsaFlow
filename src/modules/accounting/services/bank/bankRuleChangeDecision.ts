/**
 * Approving or rejecting a held bank-rule change (forensic-controls step 2;
 * Hein's decision 3). Every refusal is raised before the decision is written:
 *  - a person in their own cookie session (login-as and agents refused —
 *    there is no MCP decide tool; agents propose only);
 *  - the change is this company's (404) and still pending (409);
 *  - `digest` is the proposal the decider was shown (409);
 *  - WHO: bankRuleApprovers.ts (403);
 *  - an approval's `before` is still the rule (409 — it moved since).
 * An approval then applies the change through 877's bank_rule_change_apply,
 * in the same transaction (the rules table accepts nothing else). Migration
 * 877's decision guard re-checks the floor, the proposer and staleness.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertHumanSession, BankControlError } from './bankControlRefusal';
import { assertMayDecide } from './bankRuleApprovers';
import { lockRuleProjection, readRuleChange } from './bankRuleChangeQueries';

export interface RuleDecisionInput { decision: 'approve' | 'reject'; digest: string; note?: string | null }
export interface RuleDecisionResult { changeId: string; status: 'approved' | 'rejected'; ruleId: string | null }

const NOT_PENDING: Record<string, string> = {
  approved: 'This change has already been approved.',
  rejected: 'This change has already been rejected.',
  superseded: 'A newer change to this rule replaced this one, so it can no longer apply — propose it again if it is still wanted.',
  applied: 'This change was applied when it was made; there is nothing to decide.',
};

export async function decideRuleChange(companyId: string, changeId: string, input: RuleDecisionInput,
  actor: { userId: string }): Promise<RuleDecisionResult> {
  const approve = input.decision === 'approve';
  await assertHumanSession(approve ? 'approve a bank-rule change' : 'reject a bank-rule change');
  const seen = await readRuleChange(companyId, changeId);
  if (!seen) throw new BankControlError('NOT_FOUND', 'Bank-rule change not found.');
  // The rule first (writers lock it too), then the change itself: a second
  // decider of the same change waits here and then finds it decided.
  if (seen.kind !== 'create' && seen.ruleId) await lockRuleProjection(companyId, seen.ruleId);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bank_rule_change:${changeId}`}, 0))`;
  const change = (await readRuleChange(companyId, changeId))!;
  if (change.status !== 'pending') {
    throw new BankControlError('CHANGE_NOT_PENDING', NOT_PENDING[change.status] ?? 'This change is not awaiting a decision.');
  }
  if (input.digest !== change.digest) {
    throw new BankControlError('DIGEST_MISMATCH', 'This change is not the one you were shown. Reload the pending changes and decide again.');
  }
  const roster = await assertMayDecide(companyId, change.proposedBy, actor.userId);
  if (approve && change.kind !== 'create' && !(await stillCurrent(companyId, changeId))) {
    throw new BankControlError('RULE_CHANGED', 'The rule changed since it was proposed; this change can no longer apply — propose it again.');
  }
  const note = input.note?.trim() ? input.note.trim() : null;
  const rows = (await sql`
    INSERT INTO bank_rule_change_decisions (company_id, change_id, decision, decided_by, note, roster_snapshot, rule_id)
    VALUES (${companyId}::UUID, ${changeId}::UUID, ${approve ? 'approved' : 'rejected'}, ${actor.userId}, ${note},
            ${roster === null ? null : JSON.stringify(roster)}::jsonb,
            CASE WHEN ${approve} THEN COALESCE(${change.ruleId}::UUID, gen_random_uuid()) END)
    RETURNING rule_id
  `) as { rule_id: string | null }[];
  if (approve) await sql`SELECT public.bank_rule_change_apply(${companyId}::UUID, ${changeId}::UUID)`;
  const ruleId = rows[0]?.rule_id ? String(rows[0].rule_id) : change.ruleId;
  log.info('Bank rule change decided', {
    companyId, changeId, ruleId, kind: change.kind, decision: approve ? 'approved' : 'rejected',
    decidedBy: actor.userId, proposedBy: change.proposedBy, soleApprover: roster !== null,
  }, 'accounting');
  return { changeId, status: approve ? 'approved' : 'rejected', ruleId };
}

/** Whether the change's `before` is still the rule's current state (877's projection, compared in SQL). */
async function stillCurrent(companyId: string, changeId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT c.before IS NOT DISTINCT FROM public.bank_rule_current(c.company_id, c.rule_id) AS current
    FROM bank_rule_changes c WHERE c.company_id = ${companyId}::UUID AND c.id = ${changeId}::UUID
  `) as { current: boolean }[];
  return rows[0]?.current === true;
}
