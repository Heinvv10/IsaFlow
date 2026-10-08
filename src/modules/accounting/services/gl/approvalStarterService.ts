/**
 * "Start from recommended rules" (R-035 follow-up, PR A; goal §3).
 *
 * Creates a confirmed subset of STARTER_RULES as the company's own rules. Every
 * row goes through createRule, so each gets assertMayDemand, the legacy-type
 * refusal and its audit row. The caller runs this in ONE savepoint: a refusal
 * on any row unwinds the rows created before it, so all are created or none.
 *
 * Idempotent: a rule whose (document_type, name) is already ACTIVE for the
 * company is skipped and reported, never duplicated. The check-then-create runs
 * under a per-company advisory lock, so a double-clicked confirm cannot create
 * the set twice.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createRule, type ApprovalRule, type DocumentType } from './approvalService';
import { isApproverRole } from './approvalRank';
import { STARTER_RULES, type StarterRule } from './approvalStarterRules';
import { MAX_RULE_AMOUNT, isRuleAmount } from './approvalRuleOptions';
import type { RuleActor } from './approvalRuleGuards';

/** One confirmed row: which recommended rule, and the amount and approver the person chose. */
export interface StarterPick {
  documentType: DocumentType;
  conditionValue?: number;
  approverRole?: string;
}

export interface StarterResult {
  created: ApprovalRule[];
  skipped: { documentType: DocumentType; name: string }[];
}

type Parsed = { ok: true; picks: StarterPick[] } | { ok: false; message: string };

const templateFor = (documentType: unknown): StarterRule | undefined =>
  STARTER_RULES.find((t) => t.documentType === documentType);

/**
 * Validates the request's `rules` with typeof checks before anything is
 * coerced or written; the route answers `message` as a 400.
 */
export function parseStarterPicks(raw: unknown): Parsed {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: 'rules must be a non-empty list of recommended rules to create' };
  }
  const picks: StarterPick[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, message: 'Each rule must be an object naming its documentType' };
    }
    const { documentType, conditionValue, approverRole } = item as Record<string, unknown>;
    const template = typeof documentType === 'string' ? templateFor(documentType) : undefined;
    if (!template) {
      return { ok: false, message: `documentType must be one of: ${STARTER_RULES.map((t) => t.documentType).join(', ')}` };
    }
    if (picks.some((p) => p.documentType === template.documentType)) {
      return { ok: false, message: `${template.documentType} is listed more than once` };
    }
    if (conditionValue !== undefined && !isRuleAmount(conditionValue)) {
      return { ok: false, message: `conditionValue for ${template.documentType} must be a number from 0 to ${MAX_RULE_AMOUNT.toFixed(2)} with at most 2 decimals` };
    }
    if (template.conditionOperator === 'any' && conditionValue !== undefined && conditionValue !== template.conditionValue) {
      return { ok: false, message: `"${template.name}" matches every document of its type; it takes no amount` };
    }
    if (approverRole !== undefined && !isApproverRole(approverRole)) {
      return { ok: false, message: `approverRole for ${template.documentType} is not a role a rule may demand` };
    }
    picks.push({ documentType: template.documentType, conditionValue, approverRole });
  }
  return { ok: true, picks };
}

/** Run inside a savepoint (the route does): the first refusal must unwind every row before it. */
export async function createStarterRules(companyId: string, picks: StarterPick[], actor: RuleActor): Promise<StarterResult> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`approval_starter_rules:${companyId}`})::bigint)`;
  const result: StarterResult = { created: [], skipped: [] };
  for (const pick of picks) {
    const template = templateFor(pick.documentType)!;
    const existing = (await sql`
      SELECT 1 FROM approval_rules
      WHERE company_id = ${companyId} AND document_type = ${template.documentType}
        AND name = ${template.name} AND is_active = true
      LIMIT 1
    `) as unknown[];
    if (existing.length > 0) {
      result.skipped.push({ documentType: template.documentType, name: template.name });
      continue;
    }
    result.created.push(await createRule(companyId, {
      name: template.name,
      documentType: template.documentType,
      conditionOperator: template.conditionOperator,
      conditionValue: pick.conditionValue ?? template.conditionValue,
      approverRole: pick.approverRole ?? template.approverRole,
    }, actor));
  }
  log.info('Starter approval rules applied', {
    companyId, created: result.created.length, skipped: result.skipped.length,
  }, 'accounting');
  return result;
}
