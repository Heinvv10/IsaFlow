/**
 * Reads of bank-rule changes (forensic-controls step 2): the derived state of
 * each change (877's bank_rule_change_states), the rule's name, who proposed
 * and decided it, and its DIGEST — defined here once, in SQL, over what the
 * change would do (kind, rule, before, after). A decision names the digest it
 * was shown, so it cannot approve a proposal it did not see.
 */
import { sql } from '@/lib/neon';
import type { RuleProjection } from './bankRuleChangeControl';

export type ChangeStatus = 'applied' | 'pending' | 'approved' | 'rejected' | 'superseded';

export interface RuleChange {
  id: string;
  /** NULL only for a creation not yet approved. */
  ruleId: string | null;
  ruleName: string;
  kind: string;
  status: ChangeStatus;
  before: RuleProjection | null;
  after: RuleProjection | null;
  /** The keys that move, before → after. */
  changes: { key: string; before: unknown; after: unknown }[];
  proposedBy: string;
  proposerName: string | null;
  proposedAt: string;
  decidedBy: string | null;
  deciderName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  digest: string;
}

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

function changedKeys(before: RuleProjection | null, after: RuleProjection | null): RuleChange['changes'] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  return keys
    .map((key) => ({ key, before: before?.[key] ?? null, after: after?.[key] ?? null }))
    .filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after));
}

function toChange(r: Row): RuleChange {
  const before = (r.before ?? null) as RuleProjection | null;
  const after = (r.after ?? null) as RuleProjection | null;
  return {
    id: String(r.id), ruleId: r.rule_id ? String(r.rule_id) : null, ruleName: String(r.rule_name ?? ''), kind: String(r.kind),
    status: String(r.status) as ChangeStatus, before, after, changes: changedKeys(before, after),
    proposedBy: String(r.proposed_by), proposerName: r.proposer_name ? String(r.proposer_name) : null,
    proposedAt: iso(r.proposed_at)!, decidedBy: r.decided_by ? String(r.decided_by) : null,
    deciderName: r.decider_name ? String(r.decider_name) : null, decidedAt: iso(r.decided_at),
    decisionNote: r.decision_note ? String(r.decision_note) : null, digest: String(r.digest),
  };
}

/** One query shape for both reads; `changeId` NULL lists. */
async function query(companyId: string, opts: { changeId?: string; pendingOnly?: boolean; ruleId?: string }): Promise<RuleChange[]> {
  const rows = (await sql`
    SELECT s.id, s.rule_id, s.kind, s.status, s.before, s.after, s.proposed_by, s.proposed_at,
           s.decided_by, s.decided_at, s.decision_note,
           COALESCE(r.rule_name, s.after ->> 'rule_name', s.before ->> 'rule_name') AS rule_name,
           public.approval_company_member_name(s.company_id, s.proposed_by) AS proposer_name,
           CASE WHEN s.decided_by IS NULL THEN NULL
                ELSE public.approval_company_member_name(s.company_id, s.decided_by) END AS decider_name,
           encode(sha256(convert_to(jsonb_build_array(c.kind, c.rule_id, c.before, c.after)::TEXT, 'UTF8')), 'hex') AS digest
    FROM bank_rule_change_states s
    JOIN bank_rule_changes c ON c.id = s.id AND c.company_id = s.company_id
    LEFT JOIN bank_categorisation_rules r ON r.id = s.rule_id AND r.company_id = s.company_id
    WHERE s.company_id = ${companyId}::UUID
      AND (${opts.changeId ?? null}::UUID IS NULL OR s.id = ${opts.changeId ?? null}::UUID)
      AND (${opts.ruleId ?? null}::UUID IS NULL OR s.rule_id = ${opts.ruleId ?? null}::UUID)
      AND (${opts.pendingOnly === true} = false OR s.status = 'pending')
    ORDER BY s.seq DESC
    LIMIT 200
  `) as Row[];
  return rows.map(toChange);
}

/** The change, in this company, or null. */
export async function readRuleChange(companyId: string, changeId: string): Promise<RuleChange | null> {
  return (await query(companyId, { changeId }))[0] ?? null;
}

/** The company's changes, newest first (at most 200): pending only, or all; optionally one rule's. */
export function listRuleChanges(companyId: string, opts: { status: 'pending' | 'all'; ruleId?: string }): Promise<RuleChange[]> {
  return query(companyId, { pendingOnly: opts.status === 'pending', ruleId: opts.ruleId });
}

/** The rule's current projection, locked FOR UPDATE; null when it is not in the company. */
export async function lockRuleProjection(companyId: string, ruleId: string): Promise<RuleProjection | null> {
  const rows = (await sql`
    SELECT public.bank_rule_projection(to_jsonb(r)) AS p FROM bank_categorisation_rules r
    WHERE r.company_id = ${companyId}::UUID AND r.id = ${ruleId}::UUID FOR UPDATE
  `) as { p: RuleProjection }[];
  return rows[0]?.p ?? null;
}

/** Rules that post money unattended now (877's bank_rule_posts_money: active, and auto-posting or auto-post on) — the `bank_rule` switch's preview. */
export async function countAutoPostingRules(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::INT AS n FROM bank_categorisation_rules r
    WHERE r.company_id = ${companyId}::UUID AND public.bank_rule_posts_money(r.company_id, public.bank_rule_projection(to_jsonb(r)))
  `) as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

/** Lower-cased match patterns of creations held for approval — the seed route skips them as it skips live rules. */
export async function pendingCreationPatterns(companyId: string): Promise<string[]> {
  const rows = (await sql`
    SELECT LOWER(after ->> 'match_pattern') AS p FROM bank_rule_change_states
    WHERE company_id = ${companyId}::UUID AND status = 'pending' AND kind = 'create'
  `) as { p: string | null }[];
  return rows.map((r) => String(r.p ?? ''));
}
