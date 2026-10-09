/**
 * Bank-rule change control (forensic-controls step 2; Hein's decision 3): the
 * ONE writer of bank_categorisation_rules — create, update, toggle, delete,
 * bulk delete, seed and a customer merge's re-point (census-pinned by
 * bankRuleChangeCensus). Migration 877 does the rest:
 *  - history: the rules table's own trigger records every write that lands
 *    (`seed` / `merge` declared through isaflow.bank_rule_change_kind);
 *  - classification: bank_rule_change_needs_approval, asked here, never
 *    re-implemented. Under the `bank_rule` switch a change that needs
 *    approval is HELD — a pending bank_rule_changes row, nothing applied —
 *    and the caller is answered { status: 'pending_approval', changeId };
 *    anything else is written at once (and recorded by the trigger);
 *  - the backstop: a gated write that bypasses this module is refused by the
 *    table (23514), never applied silently.
 * Approving and rejecting: bankRuleChangeDecision.ts.
 */
import { sql, withSavepoint, type TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isEnforced } from '../gl/approvalEnforcement';
import { BANK_RULE } from '../gl/approvalRuleOptions';
import { BankControlError } from './bankControlRefusal';
import { lockRuleProjection } from './bankRuleChangeQueries';

/** A rule as 877 projects it: every column but its identity and bookkeeping (snake_case). */
export type RuleProjection = Record<string, unknown>;
export interface HeldRuleChange { status: 'pending_approval'; changeId: string }
export type RuleWrite = { status: 'applied'; row: Record<string, unknown> } | HeldRuleChange;

/** The columns a new rule's caller sets; the rest take the table's defaults (RULE_DEFAULTS). */
export interface NewRuleColumns {
  rule_name: string; match_field: string; match_type: string; match_pattern: string;
  gl_account_id: string | null; supplier_id: string | null; client_id: string | null;
  description_template: string | null; priority: number; auto_create_entry: boolean; vat_code: string; auto_apply: string;
}
/** The columns a caller may change on an existing rule. Only the keys present move (updateRule's COALESCE semantics). */
export type RulePatch = Partial<Omit<NewRuleColumns, 'rule_name'> & { rule_name: string; is_active: boolean }>;

/**
 * The table's defaults for every column createRule does not name — what the
 * INSERT below leaves to them. A held creation's `after` must be the row an
 * immediate one inserts (pinned by bank-rule-changes-held.int.test.ts).
 */
const RULE_DEFAULTS = { is_active: true, auto_approve: false, category: null, tax_rate: 15, apply_vat: false, notes: null };

/**
 * `proposed` normalised through the row type (uuid case, numerics, every
 * column), whether it must be held, and whether only is_active moved.
 */
async function classify(companyId: string, before: RuleProjection | null, proposed: RuleProjection) {
  const rows = (await sql`
    SELECT n.after,
           public.bank_rule_change_needs_approval(${companyId}::UUID, ${json(before)}::jsonb, n.after)
             AND EXISTS (SELECT 1 FROM approval_enforcement ae
                         WHERE ae.company_id = ${companyId}::UUID AND ae.document_type = ${BANK_RULE}) AS held,
           (${json(before)}::jsonb - 'is_active') = (n.after - 'is_active') AS toggle_only
    FROM (SELECT public.bank_rule_projection(to_jsonb(jsonb_populate_record(NULL::bank_categorisation_rules,
            ${json(proposed)}::jsonb))) AS after) n
  `) as { after: RuleProjection; held: boolean; toggle_only: boolean | null }[];
  return { after: rows[0]!.after, held: rows[0]!.held === true, toggleOnly: rows[0]!.toggle_only === true };
}

const json = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));

/** Records a held change. `before` is read by the database as the rule stands (it is locked), so it cannot drift. */
async function hold(companyId: string, ruleId: string | null, kind: 'create' | 'update' | 'toggle', after: RuleProjection,
  userId: string): Promise<HeldRuleChange> {
  const rows = (await sql`
    INSERT INTO bank_rule_changes (company_id, rule_id, kind, before, after, proposed_by, status)
    VALUES (${companyId}::UUID, ${ruleId}::UUID, ${kind},
            CASE WHEN ${ruleId}::UUID IS NULL THEN NULL ELSE public.bank_rule_current(${companyId}::UUID, ${ruleId}::UUID) END,
            ${json(after)}::jsonb, ${userId}, 'pending')
    RETURNING id
  `) as { id: string }[];
  const changeId = String(rows[0]!.id);
  log.info('Bank rule change held for approval', { companyId, ruleId, kind, changeId, proposedBy: userId }, 'accounting');
  return { status: 'pending_approval', changeId };
}

/** Creates a rule, or holds the creation when it would auto-post under the switch. */
export async function writeNewRule(companyId: string, cols: NewRuleColumns, userId: string): Promise<RuleWrite> {
  const { after, held } = await classify(companyId, null, { ...RULE_DEFAULTS, ...cols });
  if (held) return hold(companyId, null, 'create', after, userId);
  const rows = (await sql`
    INSERT INTO bank_categorisation_rules (
      company_id, rule_name, match_field, match_type, match_pattern,
      gl_account_id, supplier_id, client_id, description_template,
      priority, auto_create_entry, vat_code, auto_apply, created_by
    ) VALUES (
      ${companyId}::UUID, ${cols.rule_name}, ${cols.match_field}, ${cols.match_type}, ${cols.match_pattern},
      ${cols.gl_account_id}::UUID, ${cols.supplier_id}::UUID, ${cols.client_id}::UUID, ${cols.description_template},
      ${cols.priority}, ${cols.auto_create_entry}, ${cols.vat_code}, ${cols.auto_apply}, ${userId}
    ) RETURNING *
  `) as Record<string, unknown>[];
  return { status: 'applied', row: rows[0]! };
}

/**
 * Changes a rule (an update, or a toggle when only is_active is named), or
 * holds the change when it needs approval under the switch. The rule is
 * locked first, so what is classified is what is written. Throws
 * `Rule <id> not found` (as updateRule always has) for a rule not in the company.
 */
export async function writeRuleChange(companyId: string, ruleId: string, patch: RulePatch, userId: string): Promise<RuleWrite> {
  const before = await lockRuleProjection(companyId, ruleId);
  if (!before) throw new Error(`Rule ${ruleId} not found`);
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const { after, held, toggleOnly } = await classify(companyId, before, { ...before, ...defined });
  if (held) return hold(companyId, ruleId, toggleOnly ? 'toggle' : 'update', after, userId);
  // `after` is the locked row with the patch over it, so setting the editable
  // columns from it moves exactly the named ones.
  const rows = (await sql`
    UPDATE bank_categorisation_rules r SET
      rule_name = n.rule_name, match_field = n.match_field, match_type = n.match_type, match_pattern = n.match_pattern,
      gl_account_id = n.gl_account_id, supplier_id = n.supplier_id, client_id = n.client_id,
      description_template = n.description_template, priority = n.priority, auto_create_entry = n.auto_create_entry,
      vat_code = n.vat_code, auto_apply = n.auto_apply, is_active = n.is_active
    FROM jsonb_populate_record(NULL::bank_categorisation_rules, ${json(after)}::jsonb) n
    WHERE r.company_id = ${companyId}::UUID AND r.id = ${ruleId}::UUID
    RETURNING r.*
  `) as Record<string, unknown>[];
  return { status: 'applied', row: rows[0]! };
}

/**
 * Deletes rules — always applied (a deleted rule posts nothing). Locked in id
 * order; a missing or foreign id refuses the WHOLE batch (404) before any
 * delete. Repeated ids count once.
 */
export async function removeRules(companyId: string, ids: readonly string[]): Promise<number> {
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))].sort();
  if (unique.length === 0) return 0;
  const locked = (await sql`
    SELECT id FROM bank_categorisation_rules
    WHERE company_id = ${companyId}::UUID AND id = ANY(${unique}::UUID[])
    ORDER BY id FOR UPDATE
  `) as { id: string }[];
  if (locked.length !== unique.length) {
    throw new BankControlError('NOT_FOUND', unique.length === 1 ? 'Rule not found.'
      : 'One or more of these rules do not exist in this company. Nothing was deleted.');
  }
  const rows = (await sql`
    DELETE FROM bank_categorisation_rules WHERE company_id = ${companyId}::UUID AND id = ANY(${unique}::UUID[]) RETURNING id
  `) as { id: string }[];
  return rows.length;
}

/**
 * Seed rules (suggest-only), in one savepoint. A seeded rule is classified as
 * any creation is: while auto-post is on, an active suggest-only rule posts
 * money (877), so under `bank_rule` each one is HELD as its own pending
 * creation, decided like any other; the rest are inserted and recorded as `seed`.
 */
export async function seedRules(companyId: string, rules: readonly { ruleName: string; pattern: string; glAccountId: string }[],
  userId: string): Promise<{ created: number; held: number }> {
  if (rules.length === 0) return { created: 0, held: 0 };
  return withSavepoint('bank_rules_seed', async () => {
    const afters = rules.map((r) => ({ ...RULE_DEFAULTS, rule_name: r.ruleName, match_field: 'description', match_type: 'contains',
      match_pattern: r.pattern, gl_account_id: r.glAccountId, supplier_id: null, client_id: null, description_template: null,
      priority: 100, auto_create_entry: false, vat_code: 'none', auto_apply: 'fifo' }));
    const classified = (await sql`
      SELECT (e.i - 1)::INT AS i, n.after,
             public.bank_rule_change_needs_approval(${companyId}::UUID, NULL, n.after)
               AND EXISTS (SELECT 1 FROM approval_enforcement ae
                           WHERE ae.company_id = ${companyId}::UUID AND ae.document_type = ${BANK_RULE}) AS held
      FROM jsonb_array_elements(${json(afters)}::jsonb) WITH ORDINALITY AS e(v, i),
           LATERAL (SELECT public.bank_rule_projection(to_jsonb(jsonb_populate_record(NULL::bank_categorisation_rules, e.v))) AS after) n
      ORDER BY e.i
    `) as { i: number; after: RuleProjection; held: boolean }[];
    const toHold = classified.filter((c) => c.held);
    const toInsert = classified.filter((c) => !c.held).map((c) => rules[c.i]!);
    if (toHold.length > 0) {
      await sql`
        INSERT INTO bank_rule_changes (company_id, rule_id, kind, before, after, proposed_by, status)
        SELECT ${companyId}::UUID, NULL, 'create', NULL, a.v, ${userId}, 'pending'
        FROM jsonb_array_elements(${json(toHold.map((c) => c.after))}::jsonb) AS a(v)
      `;
      log.info('Seeded bank rules held for approval', { companyId, held: toHold.length, proposedBy: userId }, 'accounting');
    }
    if (toInsert.length === 0) return { created: 0, held: toHold.length };
    await sql`SELECT set_config('isaflow.bank_rule_change_kind', 'seed', true)`;
    const rows = (await sql`
      INSERT INTO bank_categorisation_rules (
        rule_name, match_field, match_type, match_pattern, gl_account_id, auto_create_entry, priority, created_by, company_id
      )
      SELECT t.name, 'description', 'contains', t.pattern, t.gl, false, 100, ${userId}, ${companyId}::UUID
      FROM unnest(${toInsert.map((r) => r.ruleName)}::TEXT[], ${toInsert.map((r) => r.pattern)}::TEXT[],
                  ${toInsert.map((r) => r.glAccountId)}::UUID[]) AS t(name, pattern, gl)
      RETURNING id
    `) as { id: string }[];
    await sql`SELECT set_config('isaflow.bank_rule_change_kind', '', true)`;
    return { created: rows.length, held: toHold.length };
  });
}

/**
 * A customer merge's re-point of the rules naming the source (customerMergeService),
 * recorded as `merge`. Under `bank_rule`, a rule naming the source that POSTS MONEY (877's bank_rule_posts_money)
 * source refuses the merge (409) before this or any other write of the merge
 * — re-pointing where it posts needs approval, and the table would otherwise
 * refuse it mid-merge. Called before the merge's first write.
 */
export async function moveRulesToCustomer(tx: TxSql, companyId: string, sourceId: string, targetId: string): Promise<void> {
  const rules = (await tx`
    SELECT r.rule_name, public.bank_rule_posts_money(r.company_id, public.bank_rule_projection(to_jsonb(r))) AS auto_posts
    FROM bank_categorisation_rules r
    WHERE r.company_id = ${companyId}::UUID AND r.client_id = ${sourceId}::UUID
    ORDER BY r.id FOR UPDATE
  `) as { rule_name: string; auto_posts: boolean }[];
  if (rules.length === 0) return;
  const posting = rules.filter((r) => r.auto_posts).map((r) => `"${r.rule_name}"`);
  if (posting.length > 0 && await isEnforced(companyId, BANK_RULE)) {
    throw new BankControlError('RULE_MERGE_HELD', `Bank rule ${posting.join(', ')} posts money for this customer unattended, and `
      + 'moving it to another customer needs a second person\'s approval. Turn auto-post off on that rule (or disable it) first, '
      + 'merge, then propose turning it back on. Nothing was merged.');
  }
  await tx`SELECT set_config('isaflow.bank_rule_change_kind', 'merge', true)`;
  await tx`UPDATE bank_categorisation_rules SET client_id = ${targetId}::UUID WHERE client_id = ${sourceId}::UUID AND company_id = ${companyId}::UUID`;
  await tx`SELECT set_config('isaflow.bank_rule_change_kind', '', true)`;
}

/**
 * Before a supplier or GL account is hard-deleted, in the caller's savepoint
 * with that DELETE: its FK sets the column NULL on every rule naming it (877
 * narrows the action to that one column). A rule that posts money and loses
 * where it posts is re-pointed — a supplier rule becomes an account rule, an
 * account rule posts to nothing — which needs approval under `bank_rule`, so
 * the table would refuse the cascade and fail the delete. Each such rule is
 * DISABLED first instead: a safe change, applied at once and recorded by the
 * history trigger; re-activating it later is held for approval like any
 * change that makes a rule post money. Returns the rules disabled.
 */
export async function disableRulesLosingTarget(companyId: string, column: 'supplier_id' | 'gl_account_id',
  ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0 || !(await isEnforced(companyId, BANK_RULE))) return [];
  const rows = (column === 'supplier_id'
    ? await sql`
        UPDATE bank_categorisation_rules r SET is_active = false
        WHERE r.company_id = ${companyId}::UUID AND r.supplier_id = ANY(${ids}::UUID[])
          AND public.bank_rule_change_needs_approval(r.company_id, public.bank_rule_projection(to_jsonb(r)),
                public.bank_rule_projection(to_jsonb(r)) || jsonb_build_object('supplier_id', NULL))
        RETURNING r.id`
    : await sql`
        UPDATE bank_categorisation_rules r SET is_active = false
        WHERE r.company_id = ${companyId}::UUID AND r.gl_account_id = ANY(${ids}::UUID[])
          AND public.bank_rule_change_needs_approval(r.company_id, public.bank_rule_projection(to_jsonb(r)),
                public.bank_rule_projection(to_jsonb(r)) || jsonb_build_object('gl_account_id', NULL))
        RETURNING r.id`) as { id: string }[];
  if (rows.length > 0) log.info('Bank rules disabled: their target is being deleted', { companyId, column, rules: rows.length }, 'accounting');
  return rows.map((r) => String(r.id));
}
