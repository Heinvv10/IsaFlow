/**
 * Bank-rule history and decisions — what the DATABASE accepts (migration
 * 877), whoever writes. Forged as app_user with real request claims, not
 * through the service: both tables are append-only; an `applied` row is the
 * rules table's own; a held change must be under the switch, need approval,
 * start from the rule's current state and carry a whole rule; a decision is
 * by a member at the admin floor who did not propose it (unless the sole one,
 * with the roster), once, in the actor's own name and tenant; the rules table
 * refuses an unapproved auto-posting write under the switch and records the
 * same write as history with it off; a batch's provenance is fixed.
 * Boundary as 876: these stop mis-wired paths, not arbitrary SQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { journalCompany } from './r035-pr6.helpers';
import { cleanupRuleChanges, enforceRules, historyOf, moveRuleSilently, plantBankRule, ruleOf } from './bank-rule-changes.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', m: '' };

beforeAll(async () => { for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens); });
afterAll(() => cleanupRuleChanges(pool, companies, Object.values(u)));

/** `fn` as app_user in a withAuth-shaped transaction (claims for `user`, company GUC). Rolled back unless `commit`. */
async function asApp<T>(user: string, company: string, fn: (db: PoolClient) => Promise<T>, commit = false): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, session_id: crypto.randomUUID() })]);
    await db.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    await db.query('SET LOCAL ROLE app_user');
    const out = await fn(db);
    await db.query(commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally { db.release(); }
}
const outcome = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`);

async function fixture(members: [string, string][] = [[u.a, 'admin'], [u.b, 'admin']], enforced = true) {
  const f = await journalCompany(pool, members, companies);
  if (enforced) await enforceRules(pool, f.c, members[0]![0]);
  const rule = await plantBankRule(pool, f.c, f.expA);
  return { ...f, rule };
}
const current = async (rule: string) => (await pool.query(
  'SELECT bank_rule_projection(to_jsonb(r)) AS p FROM bank_categorisation_rules r WHERE id = $1', [rule])).rows[0].p as Record<string, unknown>;
const insertChange = (db: PoolClient, c: string, by: string, row: { rule: string | null; kind: string; before: unknown; after: unknown;
  status?: string }) => db.query(
  `INSERT INTO bank_rule_changes(company_id, rule_id, kind, before, after, proposed_by, status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
  [c, row.rule, row.kind, row.before === null ? null : JSON.stringify(row.before), row.after === null ? null : JSON.stringify(row.after),
    by, row.status ?? 'pending']);
/** A valid held change (suggest-only → auto-post) to `rule`, by `by`, committed. */
async function pendingChange(c: string, rule: string, by: string): Promise<string> {
  const before = await current(rule);
  return asApp(by, c, async (db) => (await insertChange(db, c, by, { rule, kind: 'update', before,
    after: { ...before, auto_create_entry: true } })).rows[0].id as string, true);
}
const decide = (db: PoolClient, c: string, change: string, by: string, decision: string, extra: { rule?: string | null;
  roster?: unknown } = {}) => db.query(
  `INSERT INTO bank_rule_change_decisions(company_id, change_id, decision, decided_by, rule_id, roster_snapshot) VALUES($1,$2,$3,$4,$5,$6)`,
  [c, change, decision, by, extra.rule ?? null, extra.roster === undefined ? null : JSON.stringify(extra.roster)]);

describe('append-only', () => {
  it('UPDATE, DELETE and TRUNCATE are refused on both tables, for app_user and for the owner', async () => {
    const f = await fixture();
    const change = await pendingChange(f.c, f.rule, u.a);
    await asApp(u.b, f.c, (db) => decide(db, f.c, change, u.b, 'rejected'), true);
    for (const t of ['bank_rule_changes', 'bank_rule_change_decisions']) {
      for (const stmt of [`UPDATE ${t} SET company_id = company_id WHERE company_id = $1`, `DELETE FROM ${t} WHERE company_id = $1`]) {
        expect(await outcome(asApp(u.a, f.c, (db) => db.query(stmt, [f.c])))).toMatch(/^42501/);
        expect(await outcome(pool.query(stmt, [f.c]))).toMatch(/^42501: .*append-only/);
      }
      expect(await outcome(asApp(u.a, f.c, (db) => db.query(`TRUNCATE ${t} CASCADE`)))).toMatch(/^42501/);
    }
    expect(await outcome(pool.query('TRUNCATE bank_rule_changes CASCADE'))).toMatch(/^42501: .*append-only/);
  });
});

describe('bank_rule_changes refuses', () => {
  it('a forged `applied` row', async () => {
    const f = await fixture();
    const before = await current(f.rule);
    expect(await outcome(asApp(u.a, f.c, (db) => insertChange(db, f.c, u.a, { rule: f.rule, kind: 'update', before,
      after: { ...before, rule_name: 'forged' }, status: 'applied' })))).toMatch(/^42501: .*recorded by the rules table/);
  });

  it('a held change off the switch, not needing approval, with a stale `before`, or a partial `after`', async () => {
    const off = await fixture(undefined, false);
    const offBefore = await current(off.rule);
    expect(await outcome(asApp(u.a, off.c, (db) => insertChange(db, off.c, u.a, { rule: off.rule, kind: 'update', before: offBefore,
      after: { ...offBefore, auto_create_entry: true } })))).toMatch(/^23514: .*not enforced/);
    const f = await fixture();
    const before = await current(f.rule);
    const try_ = (row: { before: unknown; after: unknown }) => outcome(asApp(u.a, f.c, (db) => insertChange(db, f.c, u.a,
      { rule: f.rule, kind: 'update', ...row })));
    expect(await try_({ before, after: { ...before, rule_name: 'x' } })).toMatch(/^23514: .*does not need approval/);
    expect(await try_({ before: { ...before, priority: 99 }, after: { ...before, auto_create_entry: true } }))
      .toMatch(/^23514: .*not rule .* current state/);
    const { notes: _n, ...partial } = { ...before, auto_create_entry: true };
    expect(await try_({ before, after: partial })).toMatch(/^23514: .*not a whole rule/);
    expect(await try_({ before, after: { ...before, auto_create_entry: true } })).toBe('ok');
  });

  it("another person's name (RLS) and another tenant's company", async () => {
    const f = await fixture();
    const other = await fixture([[u.m, 'admin']]);
    const before = await current(f.rule);
    const after = { ...before, auto_create_entry: true };
    expect(await outcome(asApp(u.a, f.c, (db) => insertChange(db, f.c, u.b, { rule: f.rule, kind: 'update', before, after }))))
      .toMatch(/row-level security/);
    // The guard reads the switch as app_user sees it (its own tenant only), so it refuses first.
    expect(await outcome(asApp(u.a, f.c, (db) => insertChange(db, other.c, u.a, { rule: other.rule, kind: 'update',
      before, after })))).toMatch(/row-level security|not enforced for this company/);
  });
});

describe('bank_rule_change_decisions refuses', () => {
  it('the proposer, unless the sole member at the floor with the current roster; a second decision', async () => {
    const f = await fixture();
    const change = await pendingChange(f.c, f.rule, u.a);
    expect(await outcome(asApp(u.a, f.c, (db) => decide(db, f.c, change, u.a, 'rejected')))).toMatch(/proposer of a change cannot decide/);
    const snapshot = (c: string) => asApp(u.a, c, async (db) => (await db.query('SELECT approval_roster_snapshot($1,$2) AS r', [c, u.a])).rows[0].r);
    const roster = await snapshot(f.c);
    expect(await outcome(asApp(u.a, f.c, (db) => decide(db, f.c, change, u.a, 'rejected', { roster }))))
      .toMatch(/another active member could decide/);
    const sole = await fixture([[u.a, 'admin'], [u.m, 'manager']]);
    const own = await pendingChange(sole.c, sole.rule, u.a);
    const soleRoster = await snapshot(sole.c);
    expect(await outcome(asApp(u.a, sole.c, (db) => decide(db, sole.c, own, u.a, 'rejected', { roster: { others: [] } }))))
      .toMatch(/roster_snapshot is not the company roster/);
    expect(await outcome(asApp(u.a, sole.c, (db) => decide(db, sole.c, own, u.a, 'rejected', { roster: soleRoster }), true))).toBe('ok');
    expect(await outcome(asApp(u.a, sole.c, (db) => decide(db, sole.c, own, u.a, 'rejected', { roster: soleRoster }))))
      .toMatch(/not awaiting a decision|duplicate key/);
  });

  it('a member below the floor; a stale approval; another name (RLS); another tenant', async () => {
    const f = await fixture([[u.a, 'admin'], [u.b, 'admin'], [u.m, 'manager']]);
    const change = await pendingChange(f.c, f.rule, u.a);
    expect(await outcome(asApp(u.m, f.c, (db) => decide(db, f.c, change, u.m, 'rejected')))).toMatch(/admin role or above/);
    // In another's name: the guard's floor check reads users as the caller (who sees only their own row), then RLS.
    expect(await outcome(asApp(u.m, f.c, (db) => decide(db, f.c, change, u.b, 'rejected'))))
      .toMatch(/row-level security|admin role or above/);
    const other = await fixture([[u.b, 'admin']]);
    expect(await outcome(asApp(u.b, other.c, (db) => decide(db, f.c, change, u.b, 'rejected'))))
      .toMatch(/row-level security|not found in company/);
    await moveRuleSilently(pool, f.rule, "match_pattern = 'MOVED'");
    expect(await outcome(asApp(u.b, f.c, (db) => decide(db, f.c, change, u.b, 'approved', { rule: f.rule }))))
      .toMatch(/changed since this change was proposed/);
  });
});

describe('the rules table', () => {
  it('under the switch refuses an app_user write that makes a rule auto-post; with it off, the write is history', async () => {
    const f = await fixture();
    const set = (c: string, rule: string) => asApp(u.a, c, (db) => db.query(
      'UPDATE bank_categorisation_rules SET auto_create_entry = true WHERE id = $1 AND company_id = $2', [rule, c]), true);
    expect(await outcome(set(f.c, f.rule))).toMatch(/^23514: .*needs another person's approval/);
    expect((await ruleOf(pool, f.rule))!.auto_create_entry).toBe(false);
    const off = await fixture(undefined, false);
    expect(await outcome(set(off.c, off.rule))).toBe('ok');
    const last = (await historyOf(pool, off.c, off.rule)).at(-1)!;
    expect([last.kind, last.status, last.proposed_by, last.after!.auto_create_entry]).toEqual(['update', 'applied', u.a, true]);
  });
});

describe('bank_import_batches provenance', () => {
  it('who imported a batch cannot change', async () => {
    const f = await fixture();
    const { rows: [b] } = await pool.query(
      `INSERT INTO bank_import_batches(company_id, bank_account_id, statement_date, imported_by) VALUES($1,$2,DATE '2026-09-30',$3) RETURNING id`, [f.c, f.bank, u.a]);
    expect(await outcome(pool.query('UPDATE bank_import_batches SET imported_by = $2 WHERE id = $1', [b.id, u.b])))
      .toMatch(/^42501: .*cannot change/);
    await pool.query('DELETE FROM bank_import_batches WHERE id = $1', [b.id]);
  });
});
