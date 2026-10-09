/**
 * Breaker #684 REPROS 5 and 6 — what the DATABASE refuses an app_user
 * statement (real request claims, the company GUC) around 877, whatever the
 * application does:
 *  - REPRO 5: a batch's provenance cannot be shed. A batch row that lines still
 *    name cannot be deleted (it can once its lines are gone, or with its
 *    company), and a line's import_batch_id, once set, cannot move.
 *  - REPRO 6: a decision on a held rule change needs the RAISED approver role
 *    (the strictest active manual_journal rule's, never below admin) in SQL
 *    too, with bankRuleApprovers.ts's fallback: the floor suffices when only
 *    the proposer holds the raised role. TypeScript and SQL agree.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { actionRoute, bankCompany, cleanupBankControlsA, enforce, lineStatus, plantBatch, plantLine, refusalOf } from './bank-controls-a.helpers';
import { enforceRules, plantBankRule, ruleOf, ruleRoutes } from './bank-rule-changes.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', o: '' };
const r = ruleRoutes(tokens);
const act = actionRoute(tokens);

beforeAll(async () => { for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens); });
afterAll(() => cleanupBankControlsA(pool, companies, Object.values(u)));

/** `fn` as app_user with `user`'s request claims and the company GUC, committed. */
async function asApp<T>(user: string, company: string, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, session_id: crypto.randomUUID() })]);
    await db.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    await db.query('SET LOCAL ROLE app_user');
    const out = await fn(db);
    await db.query('COMMIT');
    return out;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally { db.release(); }
}
const outcome = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`);

describe('REPRO 5 — import provenance cannot be shed', () => {
  async function ownLine() {
    const f = await bankCompany(pool, [[u.a, 'admin'], [u.b, 'admin']], companies);
    await enforce(pool, f.c, u.b, ['manual_journal']);
    const batch = await plantBatch(pool, f, u.a);
    const line = await plantLine(pool, f, batch);
    const allocate = () => act(u.a, f.c, { action: 'allocate', bankTransactionId: line, allocationType: 'account', contraAccountId: f.expA });
    expect(refusalOf(await allocate())).toMatchObject({ status: 403, reason: 'IMPORTER_MAY_NOT_ALLOCATE' });
    return { f, batch, line, allocate };
  }

  it('a batch its lines still name cannot be deleted; the importer stays refused', async () => {
    const { f, batch, line, allocate } = await ownLine();
    expect(await outcome(asApp(u.a, f.c, (db) => db.query('DELETE FROM bank_import_batches WHERE id = $1', [batch]))))
      .toMatch(/^42501: .*still names? it/);
    expect(await outcome(pool.query('DELETE FROM bank_import_batches WHERE id = $1', [batch]))).toMatch(/^42501/);
    expect(refusalOf(await allocate()).status).toBe(403);
    expect(await lineStatus(pool, line)).toBe('imported');
    // Its lines gone (MCP undo_bank_import deletes lines, never the batch), the batch may go.
    await pool.query('DELETE FROM bank_transactions WHERE id = $1', [line]);
    expect(await outcome(asApp(u.a, f.c, (db) => db.query('DELETE FROM bank_import_batches WHERE id = $1', [batch])))).toBe('ok');
  });

  it("a line's import_batch_id, once set, cannot move or be cleared", async () => {
    const { f, line, allocate } = await ownLine();
    for (const set of ['gen_random_uuid()', 'NULL']) {
      expect(await outcome(asApp(u.a, f.c, (db) => db.query(`UPDATE bank_transactions SET import_batch_id = ${set} WHERE id = $1`, [line]))))
        .toMatch(/^42501: .*import batch/);
    }
    expect(refusalOf(await allocate()).status).toBe(403);
    // A hand-keyed line (no batch) is not touched by the guard; other columns of a batch line still change.
    const keyed = await plantLine(pool, f, null);
    expect(await outcome(pool.query('UPDATE bank_transactions SET description = $2 WHERE id = $1', [line, 'renamed']))).toBe('ok');
    expect(await outcome(pool.query('UPDATE bank_transactions SET import_batch_id = NULL WHERE id = $1', [keyed]))).toBe('ok');
  });

  it('R2-3: a hand-keyed line cannot be GIVEN a batch, nor any line re-pointed to a feed; the gates still refuse', async () => {
    const f = await bankCompany(pool, [[u.a, 'admin'], [u.b, 'admin']], companies);
    await enforce(pool, f.c, u.b, ['manual_journal']);
    await plantRule(pool, f.c, 'owner', { documentType: 'manual_journal', operator: 'any', value: 0 });
    const keyed = await plantLine(pool, f, null);
    const theirs = await plantBatch(pool, f, u.b);
    const allocate = (line: string) => act(u.a, f.c, { action: 'allocate', bankTransactionId: line, allocationType: 'account',
      contraAccountId: f.expA });
    expect(await outcome(asApp(u.a, f.c, (db) => db.query('UPDATE bank_transactions SET import_batch_id = $2 WHERE id = $1', [keyed, theirs]))))
      .toMatch(/^42501: .*feed connection are its provenance/);
    expect((await allocate(keyed)).state.statusCode).toBe(409);
    const imported = await plantLine(pool, f, await plantBatch(pool, f, u.a));
    const feed = (await pool.query(
      "INSERT INTO bank_feed_connections(company_id, bank_account_id, provider, status) VALUES($1,$2,'extension','active') RETURNING id",
      [f.c, f.bank])).rows[0].id;
    expect(await outcome(asApp(u.a, f.c, (db) => db.query('UPDATE bank_transactions SET bank_feed_connection_id = $2 WHERE id = $1',
      [imported, feed])))).toMatch(/^42501/);
    expect(refusalOf(await allocate(imported))).toMatchObject({ status: 403, reason: 'IMPORTER_MAY_NOT_ALLOCATE' });
  });
});

describe('REPRO 6 — the raised approver role, in SQL too', () => {
  async function held(members: [string, string][], proposer: string) {
    const f = await bankCompany(pool, members, companies);
    await plantRule(pool, f.c, 'owner', { documentType: 'manual_journal', operator: 'any', value: 0 });
    await enforceRules(pool, f.c, members[0]![0]);
    const rule = await plantBankRule(pool, f.c, f.expA, { pattern: 'BRK684R4' });
    const res = await r.action(proposer, f.c, { action: 'update', id: rule, autoCreateEntry: true });
    return { f, rule, changeId: dataOf<{ changeId: string }>(res).changeId };
  }
  const sqlApprove = (user: string, c: string, changeId: string, rule: string) => outcome(asApp(user, c, async (db) => {
    await db.query(`INSERT INTO bank_rule_change_decisions(company_id, change_id, decision, decided_by, rule_id)
      VALUES($1,$2,'approved',$3,$4)`, [c, changeId, user, rule]);
    await db.query('SELECT public.bank_rule_change_apply($1,$2)', [c, changeId]);
  }));

  it('an admin below an owner-level manual_journal rule is refused by the route AND by the database', async () => {
    const { f, rule, changeId } = await held([[u.o, 'owner'], [u.a, 'admin'], [u.b, 'admin']], u.a);
    expect(refusalOf(await r.decide(u.b, f.c, changeId, 'approve'))).toMatchObject({ status: 403, reason: 'APPROVER_ROLE_REQUIRED' });
    expect(await sqlApprove(u.b, f.c, changeId, rule)).toMatch(/^23514: .*owner role or above/);
    expect((await ruleOf(pool, rule))!.auto_create_entry).toBe(false);
    // The owner may, through the route (TypeScript and the guard agree).
    expect((await r.decide(u.o, f.c, changeId, 'approve')).state.statusCode).toBe(200);
    expect((await ruleOf(pool, rule))!.auto_create_entry).toBe(true);
  });

  it('only the proposer holds the raised role: an admin may decide, in the route and in SQL', async () => {
    const viaRoute = await held([[u.o, 'owner'], [u.b, 'admin']], u.o);
    expect((await r.decide(u.b, viaRoute.f.c, viaRoute.changeId, 'approve')).state.statusCode).toBe(200);
    const viaSql = await held([[u.o, 'owner'], [u.b, 'admin']], u.o);
    expect(await sqlApprove(u.b, viaSql.f.c, viaSql.changeId, viaSql.rule)).toBe('ok');
    expect((await ruleOf(pool, viaSql.rule))!.auto_create_entry).toBe(true);
  });
});
