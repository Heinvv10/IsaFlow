/**
 * Migration 885: the `bank_rule` switch is written only through 881's
 * SECURITY DEFINER approval_enforcement_set, whose bank_rule branch refuses
 * what approvalEnforcement.ts refuses — as app_user with real claims, not
 * through the service:
 *  - app_user cannot INSERT the switch row itself (881's grants);
 *  - an impersonated or claim-less session is refused, on and off (RB012);
 *  - on: a role below bank_rule_approver_role (877) is refused (RB014) — an
 *    owner-level manual_journal rule raises it to owner;
 *  - off: a role without the authority to weaken that role is refused (RB011);
 *  - on: the definer takes bankRuleAutoPostLock's lock EXCLUSIVE before the
 *    row, so it waits for a rule writer holding it shared (R3-1's ordering).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanup, createUser, newCompany, plantRule } from './r035-approval.helpers';
import { asRole, outcome } from './r035-n1.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const u = { o: '', a: '', m: '' };

beforeAll(async () => { for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, {}); });
afterAll(async () => {
  await pool.query('DELETE FROM impersonation_sessions WHERE target_user_id = ANY($1::text[])', [Object.values(u)]);
  await cleanup(pool, companies, Object.values(u));
});

const company = () => newCompany(pool, [[u.o, 'owner'], [u.a, 'admin'], [u.m, 'manager']], companies);
const set = (c: string, user: string, enabled: boolean, claims: { sessionId?: string | null } = {}) =>
  asRole(pool, 'app_user', c, { sub: user, ...claims }, (cl) => cl.query(
    "SELECT * FROM approval_enforcement_set($1, 'bank_rule', $2, $3)", [c, enabled, user]), true);
const on = async (c: string) => (await pool.query(
  "SELECT 1 FROM approval_enforcement WHERE company_id = $1 AND document_type = 'bank_rule'", [c])).rowCount === 1;

describe('approval_enforcement_set: bank_rule', () => {
  it('app_user cannot write the switch row itself', async () => {
    const c = await company();
    expect(await outcome(asRole(pool, 'app_user', c, { sub: u.o }, (cl) => cl.query(
      "INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1, 'bank_rule', $2)", [c, u.o])))).toBe('42501');
    expect(await on(c)).toBe(false);
  });

  it('an impersonated or claim-less session is refused, on and off (RB012); its own session is not', async () => {
    const c = await company();
    const sessionId = crypto.randomUUID();
    await pool.query('INSERT INTO impersonation_sessions(session_id, actor_user_id, target_user_id) VALUES($1,$2,$3)', [sessionId, u.a, u.o]);
    for (const claims of [{ sessionId }, { sessionId: null }]) {
      expect(await outcome(set(c, u.o, true, claims))).toBe('RB012');
    }
    expect(await outcome(set(c, u.o, true))).toBe('ok');
    for (const claims of [{ sessionId }, { sessionId: null }]) {
      expect(await outcome(set(c, u.o, false, claims))).toBe('RB012');
    }
    expect(await on(c)).toBe(true);
    const audit = (await pool.query(
      "SELECT action FROM audit_log WHERE company_id = $1 AND entity_type = 'approval_enforcement' AND entity_ref = 'bank_rule'", [c])).rows;
    expect(audit.map((r) => r.action)).toEqual(['create']);
  });

  it('on: below the approver role is refused (RB014); an owner-level manual_journal rule raises it to owner', async () => {
    const c = await company();
    expect(await outcome(set(c, u.m, true))).toBe('RB014');
    await plantRule(pool, c, 'owner', { documentType: 'manual_journal', operator: 'any', value: 0 });
    expect(await outcome(set(c, u.a, true))).toBe('RB014');
    expect(await on(c)).toBe(false);
    expect(await outcome(set(c, u.o, true))).toBe('ok');
  });

  it('off: only the authority to weaken the approver role (RB011 for an admin at admin level; the owner may)', async () => {
    const c = await company();
    expect(await outcome(set(c, u.a, true))).toBe('ok');
    expect(await outcome(set(c, u.a, false))).toBe('RB011');
    expect(await on(c)).toBe(true);
    expect(await outcome(set(c, u.o, false))).toBe('ok');
    expect(await on(c)).toBe(false);
  });

  it('on: waits for a rule writer holding bankRuleAutoPostLock shared, then writes the row', async () => {
    const c = await company();
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('bank_rule_auto_post:' || $1::text, 0))", [c]);
      let done = false;
      const enabling = set(c, u.o, true).finally(() => { done = true; });
      let waiting = 0;
      for (let i = 0; i < 100 && !done && waiting === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        waiting = Number((await pool.query(`SELECT count(*) FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`)).rows[0].count);
      }
      expect({ waiting: waiting > 0, done }).toEqual({ waiting: true, done: false });
      await writer.query('COMMIT');
      await enabling;
    } finally { writer.release(); }
    expect(await on(c)).toBe(true);
  });
});
