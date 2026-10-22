/**
 * The adversarial reviewer's repros for PR #679 (supplier bank-detail
 * verification), kept as regression tests: each was red at c718db69a and
 * asserts what the control claims. Not kept: REPRO 5c (the supplier NAME,
 * sent as beneficiary / Netcash account holder, is not in the fingerprint) —
 * the fingerprint is the five bank columns (decision 4) and the name routes
 * no money; a documented limit in docs/design/r035-approval-enforcement.md.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';

const submitEftBatch = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch }));

import approvalRules from '../../pages/api/accounting/approval-rules';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, reasonOf } from './r035-approval.helpers';
import { dataOf, impersonationToken } from './r035-pr2.helpers';
import { cleanupPr5, plantApprovedBatch } from './r035-pr5.helpers';
import { bankCompany, bankRoutes, verificationsOf } from './supplier-bank-verification.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
/** a admin (attacker unless stated), b owner, c admin, k bookkeeper, p platform actor for impersonation. */
const u = { a: '', b: '', c: '', k: '', p: '' };
const r = bankRoutes(pool, tokens);
const rule = (user: string, c: string, method: string, body: Record<string, unknown>) =>
  callRoute(approvalRules, tokens[user]!, c, method, body, '/api/accounting/approval-rules');

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
beforeEach(() => {
  submitEftBatch.mockReset();
  submitEftBatch.mockResolvedValue({ success: true, batchReference: 'BRK-SPY', mock: true });
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

async function enforcedBatch(members: [string, string][], on: string) {
  const { company: c, bank } = await bankCompany(pool, members, companies);
  const batch = await plantApprovedBatch(pool, c, on, bank);
  const res = await r.toggle(on, c, true);
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return { c, batch, s: batch.members[0]!.supplierId };
}

const fileLines = (res: { state: { body: unknown } }) => dataOf<{ content: string }>(res).content.split('\n');

describe('REPRO 1 — an admin lowers the verifier role with an inert payment rule, then switches the control off alone', () => {
  it('switching off stays refused to the admin (default verifier role admin => owner only)', async () => {
    const { c, batch, s } = await enforcedBatch([[u.a, 'admin'], [u.b, 'owner'], [u.k, 'bookkeeper']], u.b);
    // Premise: refused while no supplier-payment rule exists.
    const first = await r.toggle(u.a, c, false);
    expect(first.state.statusCode).toBe(403);
    // A bookkeeper-level supplier_payment rule that matches no realistic amount: allowed (admin may demand bookkeeper).
    const created = await rule(u.a, c, 'POST', {
      name: 'inert', documentType: 'supplier_payment', conditionField: 'total',
      conditionOperator: 'greater_than', conditionValue: 999999999999, approverRole: 'bookkeeper',
    });
    expect(created.state.statusCode, JSON.stringify(created.state.body)).toBe(200);
    const off = await r.toggle(u.a, c, false);
    // The break: verifier role is now bookkeeper, and admin > bookkeeper may weaken it.
    await r.changeBank(u.a, c, s, { bankAccountNumber: '62999999999' });
    const eft = await r.eft(u.a, c, batch.id);
    expect({ off: off.state.statusCode, eft: eft.state.statusCode }).toEqual({ off: 403, eft: 409 });
  });

  it('a manager must not become a bank-detail verifier through an inert rule an admin planted', async () => {
    const { c, s } = await enforcedBatch([[u.a, 'admin'], [u.b, 'owner'], [u.k, 'manager']], u.b);
    await r.changeBank(u.a, c, s, { bankAccountNumber: '62999999999' });
    expect(reasonOf(await r.verify(u.k, c, s))).toBe('VERIFIER_ROLE_REQUIRED'); // premise
    await rule(u.a, c, 'POST', {
      name: 'inert', documentType: 'supplier_payment', conditionField: 'total',
      conditionOperator: 'greater_than', conditionValue: 999999999999, approverRole: 'manager',
    });
    const res = await r.verify(u.k, c, s);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(403);
  });
});

describe('REPRO 2 — the owner manufactures being the sole approver by raising the verifier role, then self-verifies', () => {
  it('an owner who set the details may not self-verify while an admin could have verified them', async () => {
    const { c, batch, s } = await enforcedBatch([[u.b, 'owner'], [u.c, 'admin']], u.b);
    await r.changeBank(u.b, c, s, { bankAccountNumber: '62888888888' });
    expect(reasonOf(await r.verify(u.b, c, s))).toBe('SETTER_FORBIDDEN'); // premise: the admin can verify
    const created = await rule(u.b, c, 'POST', {
      name: 'raise', documentType: 'payment_batch', conditionField: 'total',
      conditionOperator: 'greater_than', conditionValue: 999999999999, approverRole: 'owner',
    });
    expect(created.state.statusCode, JSON.stringify(created.state.body)).toBe(200);
    const self = await r.verify(u.b, c, s);
    const ruleId = dataOf<{ id: string }>(created).id;
    await rule(u.b, c, 'PUT', { id: ruleId, isActive: false });
    const eft = await r.eft(u.b, c, batch.id);
    expect({ verify: self.state.statusCode, eft: eft.state.statusCode,
      kinds: (await verificationsOf(pool, s)).map((x) => x.kind) })
      .toEqual({ verify: 403, eft: 409, kinds: ['baseline'] });
  });
});

describe('REPRO 3 — switching off and on again baselines a pending change nobody verified', () => {
  it("an admin's unverified change stays unverified across the owner's off/on", async () => {
    const { c, batch, s } = await enforcedBatch([[u.a, 'admin'], [u.b, 'owner'], [u.c, 'admin']], u.b);
    await r.changeBank(u.a, c, s, { bankAccountNumber: '62777777777' });
    expect((await r.state(u.c, c, s)).state).toBe('unverified');
    expect((await r.toggle(u.b, c, false)).state.statusCode).toBe(200);
    expect((await r.toggle(u.b, c, true)).state.statusCode).toBe(200);
    const eft = await r.eft(u.a, c, batch.id);
    expect({ state: (await r.state(u.c, c, s)).state, eft: eft.state.statusCode })
      .toEqual({ state: 'unverified', eft: 409 });
  });
});

/** As app_user in a withAuth-shaped transaction (claims for `user`, company GUC), committed. */
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
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}
const current = async (s: string) => (await pool.query(
  `SELECT supplier_bank_fingerprint(bank_name, bank_account_number, bank_branch_code, bank_account_type, bank_account_holder) AS f
   FROM suppliers WHERE id = $1`, [s])).rows[0].f as string;

describe('REPRO 4 — the table accepts rows the service would never write (app_user, own claims)', () => {
  it('a setter self_verifies with an invented roster while another admin exists, pinned latest by OVERRIDING SYSTEM VALUE', async () => {
    const { c, batch, s } = await enforcedBatch([[u.a, 'admin'], [u.b, 'owner'], [u.c, 'admin']], u.b);
    await r.changeBank(u.a, c, s, { bankAccountNumber: '62666666666' });
    let err: unknown = null;
    try {
      await asApp(u.a, c, async (db) => db.query(
        `INSERT INTO supplier_bank_verifications(seq, company_id, supplier_id, fingerprint, kind, method, note, verified_by, roster_snapshot)
         OVERRIDING SYSTEM VALUE VALUES(9000000000000000000, $1, $2, $3, 'self_verified', 'other', 'forged', $4, '{}'::JSONB)`,
        [c, s, await current(s), u.a]));
    } catch (e) { err = e; }
    const eft = await r.eft(u.a, c, batch.id);
    expect({ refused: err !== null, eft: eft.state.statusCode }).toEqual({ refused: true, eft: 409 });
  });

  it('a bookkeeper (below the verifier floor) cannot write a plain verified row', async () => {
    const { c, s } = await enforcedBatch([[u.a, 'admin'], [u.b, 'owner'], [u.k, 'bookkeeper']], u.b);
    await r.changeBank(u.a, c, s, { bankAccountNumber: '62555555555' });
    let err: unknown = null;
    try {
      await asApp(u.k, c, async (db) => db.query(
        `INSERT INTO supplier_bank_verifications(company_id, supplier_id, fingerprint, kind, method, note, verified_by)
         VALUES($1, $2, $3, 'verified', 'other', 'forged', $4)`, [c, s, await current(s), u.k]));
    } catch (e) { err = e; }
    expect(err).not.toBeNull();
  });
});

describe('REPRO 5 — the fingerprint is looser than what the bank file carries', () => {
  it('a case-only account-type edit leaves the ACB account-type code unchanged', async () => {
    const { c, batch, s } = await enforcedBatch([[u.a, 'admin'], [u.b, 'owner'], [u.c, 'admin']], u.b);
    await r.changeBank(u.c, c, s, { bankAccountType: 'savings' });
    expect((await r.verify(u.b, c, s)).state.statusCode).toBe(200);
    const before = await r.eft(u.a, c, batch.id);
    const acct = (res: typeof before) => fileLines(res).find((l) => l.includes('62000000001'))!;
    await r.changeBank(u.a, c, s, { bankAccountType: 'Savings' });
    const after = await r.eft(u.a, c, batch.id);
    expect(after.state.statusCode).toBe(200); // still "verified"
    expect(acct(after)).toBe(acct(before));
  });

  it('separators in the account number leave the file line unchanged (digits only)', async () => {
    const { c, batch, s } = await enforcedBatch([[u.a, 'admin'], [u.b, 'owner'], [u.c, 'admin']], u.b);
    const before = fileLines(await r.eft(u.a, c, batch.id));
    await r.changeBank(u.a, c, s, { bankAccountNumber: '6-2000000001' });
    const res = await r.eft(u.a, c, batch.id);
    expect(res.state.statusCode).toBe(200); // still "verified"
    expect(fileLines(res)).toEqual(before);
  });

});

describe('REPRO 6 — an impersonated session switches the control off', () => {
  it('switching off is refused to "login as", like switching on', async () => {
    const { c } = await enforcedBatch([[u.b, 'owner'], [u.c, 'admin']], u.b);
    const off = await r.toggle(u.b, c, false, await impersonationToken(pool, u.b, u.p));
    expect(off.state.statusCode).toBe(403);
  });
});

describe('CONTROL (expected green) — E: the purge of a soft-deleted supplier as app_user is not blocked', () => {
  it('app_user hard-deletes a soft-deleted supplier that has verifications', async () => {
    const { company: c } = await bankCompany(pool, [[u.b, 'owner']], companies);
    const s = crypto.randomUUID();
    await pool.query(`INSERT INTO suppliers(id,company_id,name,bank_account_number,bank_branch_code) VALUES($1,$2,'purge me','62000000001','250655')`, [s, c]);
    expect((await r.toggle(u.b, c, true)).state.statusCode).toBe(200);
    await pool.query("UPDATE suppliers SET deleted_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [s]);
    const n = await asApp(u.b, c, async (db) => (await db.query('DELETE FROM suppliers WHERE id = $1 AND company_id = $2 RETURNING id', [s, c])).rowCount);
    expect(n).toBe(1);
    expect(await verificationsOf(pool, s)).toEqual([]);
  });
});
