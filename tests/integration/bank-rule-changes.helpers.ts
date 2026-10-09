/**
 * Fixture for the bank-rule change suites (forensic-controls step 2, slice b):
 * a company whose journals can post (r035-pr6's journalCompany), members
 * created per case, the `bank_rule` switch planted, rules planted directly,
 * and the real routes a person drives — create (bank-rules), update / toggle /
 * delete (bank-rules-action), list and decide (bank-rule-changes) — plus the
 * MCP rule tools run as the bearer pipeline runs them (app_user, claims with
 * no session id).
 */
import type { Pool, PoolClient } from 'pg';
import bankRules from '../../pages/api/accounting/bank-rules';
import bankRulesAction from '../../pages/api/accounting/bank-rules-action';
import bankRuleChanges from '../../pages/api/accounting/bank-rule-changes';
import { als } from '../../src/lib/als';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { createBankRuleTool, disableBankRuleTool, updateBankRuleTool } from '../../src/lib/mcp/tools/writeBankRules';
import { callRoute } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { cleanupPr6 } from './r035-pr6.helpers';

type Tokens = Record<string, string>;
type Db = Pool | PoolClient;
type Res = Awaited<ReturnType<typeof callRoute>>;

export async function enforceRules(db: Db, company: string, by: string): Promise<void> {
  await db.query("INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1,'bank_rule',$2)", [company, by]);
}

/**
 * A rule planted directly (the history trigger records it as `db:postgres`).
 * Suggest-only unless `opts` says otherwise. An auto-posting rule is planted
 * with the `bank_rule` switch lifted for that one transaction (the table would
 * refuse it), as if it predated the switch.
 */
export async function plantBankRule(pool: Pool, company: string, glAccountId: string, opts: {
  autoPost?: boolean; active?: boolean; pattern?: string; name?: string; clientId?: string | null;
} = {}): Promise<string> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows: lifted } = await db.query(
      "DELETE FROM approval_enforcement WHERE company_id = $1 AND document_type = 'bank_rule' RETURNING *", [company]);
    const { rows: [r] } = await db.query(
      `INSERT INTO bank_categorisation_rules(company_id, rule_name, match_field, match_type, match_pattern, gl_account_id,
         auto_create_entry, is_active, client_id, priority)
       VALUES($1,$2,'description','contains',$3,$4,$5,$6,$7,100) RETURNING id`,
      [company, opts.name ?? 'BRC rule', opts.pattern ?? 'BRCMATCH', glAccountId, opts.autoPost ?? false, opts.active ?? true,
        opts.clientId ?? null]);
    for (const e of lifted) {
      await db.query('INSERT INTO approval_enforcement(company_id, document_type, enabled_by, enabled_at) VALUES($1,$2,$3,$4)',
        [e.company_id, e.document_type, e.enabled_by, e.enabled_at]);
    }
    await db.query('COMMIT');
    return String(r.id);
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally { db.release(); }
}

export interface ChangeView {
  id: string; ruleId: string | null; ruleName: string; kind: string; status: string; digest: string;
  proposedBy: string; proposerName: string | null; canDecide: boolean;
  changes: { key: string; before: unknown; after: unknown }[];
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
}

export function ruleRoutes(tokens: Tokens) {
  const as = (user: string) => tokens[user]!;
  const r = {
    create: (user: string, c: string, body: Record<string, unknown>, token = as(user)) =>
      callRoute(bankRules, token, c, 'POST', { ruleName: 'BRC created', matchField: 'description', matchType: 'contains',
        matchPattern: 'BRCMATCH', ...body }, '/api/accounting/bank-rules'),
    action: (user: string, c: string, body: Record<string, unknown>, token = as(user)) =>
      callRoute(bankRulesAction, token, c, 'POST', body, '/api/accounting/bank-rules-action'),
    list: (user: string, c: string, query: Record<string, string> = {}, token = as(user)) =>
      callRoute(bankRuleChanges, token, c, 'GET', undefined, '/api/accounting/bank-rule-changes', query),
    changes: async (user: string, c: string, query: Record<string, string> = {}) => {
      const res = await r.list(user, c, query);
      if (res.state.statusCode !== 200) throw new Error(`list: ${JSON.stringify(res.state.body)}`);
      return dataOf<{ items: ChangeView[] }>(res).items;
    },
    /** POST a decision; `digest` defaults to the one `user` is shown now — what the panel sends. */
    decide: async (user: string, c: string, changeId: string, action: 'approve' | 'reject', body: Record<string, unknown> = {},
      token = as(user)): Promise<Res> => {
      const digest = 'digest' in body ? body.digest
        : (await r.changes(user, c, { status: 'all' })).find((x) => x.id === changeId)?.digest;
      return callRoute(bankRuleChanges, token, c, 'POST', { action, changeId, ...body, digest }, '/api/accounting/bank-rule-changes');
    },
  };
  return r;
}

/** An MCP rule tool as the bearer pipeline runs it: app_user, the token user's claims (no session id), committed. */
export function mcpRules(pool: Pool) {
  const registry = new McpRegistry();
  for (const tool of [createBankRuleTool, updateBankRuleTool, disableBankRuleTool]) registry.register(tool);
  return async (user: string, c: string, name: string, args: Record<string, unknown>) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      const claims = { sub: user, role: 'authenticated', company_id: c };
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [c]);
      const out = await als.run({ client, userId: user, companyId: c, claims, afterCommit: [] } as never, () => registry.call(name,
        { idempotency_key: crypto.randomUUID(), ...args },
        { userId: user, companyId: c, scopes: ['write:bank-tx'], tokenJti: 'brc', oauthAppId: null }));
      await client.query('COMMIT');
      return out as { isError?: boolean; content: { text: string }[] };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  };
}

export const historyOf = async (pool: Pool, c: string, ruleId?: string) => (await pool.query(
  `SELECT id, rule_id, kind, before, after, proposed_by, status FROM bank_rule_change_states
   WHERE company_id = $1 AND ($2::UUID IS NULL OR rule_id = $2) ORDER BY seq`, [c, ruleId ?? null])).rows as {
  id: string; rule_id: string | null; kind: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null;
  proposed_by: string; status: string;
}[];

export const ruleOf = async (pool: Pool, id: string) => (await pool.query(
  'SELECT * FROM bank_categorisation_rules WHERE id = $1', [id])).rows[0] as Record<string, unknown> | undefined;

/** Writes a rule with every trigger off (superuser, replica role): it moves without a history row or a supersession. */
export async function moveRuleSilently(pool: Pool, id: string, set: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(`UPDATE bank_categorisation_rules SET ${set} WHERE id = $1`, [id]);
    await client.query('COMMIT');
  } finally { client.release(); }
}

/**
 * The history is append-only for every role, and its FK to companies has no
 * cascade (reported as an 877 defect): it is removed with triggers off, then
 * PR6's teardown runs. Rules go first, inside the same replica session, so
 * deleting them records nothing.
 */
export async function cleanupRuleChanges(pool: Pool, companies: string[], users: string[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query('DELETE FROM bank_rule_change_decisions WHERE company_id = ANY($1)', [companies]);
    await client.query('DELETE FROM bank_rule_changes WHERE company_id = ANY($1)', [companies]);
    await client.query('DELETE FROM bank_categorisation_rules WHERE company_id = ANY($1)', [companies]);
    await client.query('COMMIT');
  } finally { client.release(); }
  await cleanupPr6(pool, companies, users);
}
