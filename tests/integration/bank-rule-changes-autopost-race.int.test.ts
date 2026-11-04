/**
 * Breaker round 2, hole 4: switching auto-post on and changing a rule must
 * serialise (bankRuleAutoPostLock). The window is opened deterministically:
 * `sql` is wrapped, and right after the switch-on has read the unreviewed
 * changes (877's bank_rule_unreviewed_changes) — before it writes — an admin
 * re-points a suggest-only rule. The admin's change must WAIT for the switch-on
 * to commit (an advisory-lock wait, seen in pg_stat_activity) and then, seeing
 * auto-post on, be HELD. Without the lock it would apply with auto-post read as
 * off, and the switch-on would commit over a change nobody approved.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import bankAutoPost from '../../pages/api/accounting/bank-auto-post';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { bankCompany, cleanupBankControlsA } from './bank-controls-a.helpers';
import {
  enforceRules,
  historyOf,
  mcpRules,
  plantBankRule,
  ruleOf,
  ruleRoutes,
} from './bank-rule-changes.helpers';

const hook = vi.hoisted(() => ({ armed: null as null | (() => Promise<void>), fired: false }));
vi.mock('@/lib/neon', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/neon')>();
  const realSql = real.sql;
  const sql = ((s: TemplateStringsArray, ...v: unknown[]) => {
    if (hook.armed && s.join('?').includes('bank_rule_unreviewed_changes')) {
      const fire = hook.armed;
      hook.armed = null;
      return (async () => {
        const out = await realSql(s, ...v);
        hook.fired = true;
        await fire();
        return out;
      })();
    }
    return realSql(s, ...v);
  }) as typeof realSql;
  Object.assign(sql, realSql);
  return { ...real, sql, default: sql };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { o: '', a: '' };
const r = ruleRoutes(tokens);
const mcp = mcpRules(pool);

beforeAll(async () => { for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens); });
afterAll(() => cleanupBankControlsA(pool, companies, Object.values(u)));

const advisoryWaiters = async () => Number((await pool.query(
  `SELECT count(*) FROM pg_stat_activity
   WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`)).rows[0].count);

describe('switching auto-post on races a rule change', () => {
  it('the rule change waits for the switch-on, then is held; it never lands unreviewed behind it', async () => {
    const f = await bankCompany(pool, [[u.o, 'owner'], [u.a, 'admin']], companies);
    await pool.query('INSERT INTO bank_auto_post_settings(company_id, enabled) VALUES($1, false)', [f.c]);
    const rule = await plantBankRule(pool, f.c, f.expA);
    await enforceRules(pool, f.c, u.o);
    let edit: Promise<Awaited<ReturnType<typeof r.action>>> | null = null;
    let settled = false;
    hook.armed = async () => {
      edit = r.action(u.a, f.c, { action: 'update', id: rule, glAccountId: f.expB });
      void edit.then(() => { settled = true; }, () => { settled = true; });
      for (let i = 0; i < 100 && !settled && (await advisoryWaiters()) === 0; i++) await new Promise((res) => setTimeout(res, 50));
    };
    const on = await callRoute(bankAutoPost as never, tokens[u.o]!, f.c, 'PUT', { enabled: true }, '/api/accounting/bank-auto-post');
    expect(hook.fired).toBe(true);
    expect(on.state.statusCode, JSON.stringify(on.state.body)).toBe(200);
    const res = await edit!;
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(dataOf<{ status: string }>(res).status).toBe('pending_approval');
    expect((await ruleOf(pool, rule))!.gl_account_id).toBe(f.expA);
  });

  it('an MCP create waits for a company-setting flip, then applies the write:post gate', async () => {
    const f = await bankCompany(pool, [[u.o, 'owner'], [u.a, 'admin']], companies);
    await pool.query('INSERT INTO bank_auto_post_settings(company_id, enabled) VALUES($1, false)', [f.c]);
    await enforceRules(pool, f.c, u.o);
    const concurrent = await pool.connect();
    let committed = false;
    let call: ReturnType<ReturnType<typeof mcpRules>> | null = null;
    let result: Awaited<ReturnType<ReturnType<typeof mcpRules>>> | null = null;
    try {
      await concurrent.query('BEGIN');
      await concurrent.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('bank_rule_auto_post:' || $1::text, 0))`,
        [f.c],
      );
      await concurrent.query('UPDATE bank_auto_post_settings SET enabled = true WHERE company_id = $1', [f.c]);

      call = mcp(u.a, f.c, 'create_bank_rule', {
        rule_name: 'MCP setting race',
        match_field: 'description',
        match_type: 'contains',
        match_pattern: 'MCPSETTINGRACE',
        gl_account_id: f.expA,
      });
      for (let i = 0; i < 100 && (await advisoryWaiters()) === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await advisoryWaiters()).toBeGreaterThan(0);

      await concurrent.query('COMMIT');
      committed = true;
      result = await call;
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toEqual({
        success: false,
        error: {
          code: 'INSUFFICIENT_SCOPE',
          message: expect.stringMatching(/write:post/),
        },
      });
    } finally {
      if (!committed) await concurrent.query('ROLLBACK');
      if (call && !result) await call.catch(() => undefined);
      concurrent.release();
    }

    expect((await historyOf(pool, f.c)).filter((entry) => entry.status === 'pending')).toEqual([]);
    expect(Number((await pool.query(
      'SELECT count(*) FROM bank_categorisation_rules WHERE company_id = $1', [f.c])).rows[0].count)).toBe(0);
    expect((await pool.query(
      `SELECT status, idempotency_key FROM mcp_tool_calls
       WHERE company_id = $1 AND tool = 'create_bank_rule' ORDER BY created_at DESC LIMIT 1`, [f.c])).rows[0])
      .toEqual({ status: 'rejected', idempotency_key: null });
  });
});
