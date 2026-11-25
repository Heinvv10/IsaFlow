/**
 * W18 (wave 7 AQ, migration 1050): approval_request_decide and approval_request_raise read the actor id without
 * case. 872 compared `requested_by::text = p_decided_by` exactly, so an upper-cased spelling of the requester's own
 * id was "not self"; it was refused anyway, but only because the role lookup (`cu.user_id = p_actor`) also missed it
 * (RA008), not because the self-approval check caught it. The first block proves that 872 behaviour on this fixture
 * (872's body, loaded inside a rolled-back transaction); the rest pins 1050's: the same id in any case is the same
 * person, for the self check, the author check, the role and the roster.
 * The JWT subject is the id as GoTrue issues it (lower case) unless a test says otherwise.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupPr2 } from './r035-pr2.helpers';
import { asRole, decideFn, n1Users, outcome, pendingBill, raiseFn, requestRow } from './r035-n1.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const twins: string[] = [];
let u: Awaited<ReturnType<typeof n1Users>>;
const up = (id: string) => id.toUpperCase();

beforeAll(async () => { u = await n1Users(pool, tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM company_users WHERE user_id = ANY($1::text[])', [twins]);
  await cleanupPr2(pool, companies, [...Object.values(u), ...twins]);
});

/**
 * A case twin: a users + company_users row whose id is the upper-cased spelling of `id`, holding `role`, inserted
 * BEFORE `id`'s own row (company_users.user_id is TEXT and its key is case-sensitive, so both rows can exist).
 */
async function plantTwin(c: string, id: string, role: string) {
  const twin = up(id);
  if (!twins.includes(twin)) {
    twins.push(twin);
    await pool.query("INSERT INTO users(id, email, role, is_active) VALUES($1, $2, 'admin', true)",
      [twin, `twin-${id}@example.invalid`]);
  }
  const real = (await pool.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [c, id])).rows[0].role;
  await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [c, id]);
  await pool.query('INSERT INTO company_users(company_id, user_id, role) VALUES($1, $2, $3)', [c, twin, role]);
  await pool.query('INSERT INTO company_users(company_id, user_id, role) VALUES($1, $2, $3)', [c, id, real]);
}

const digestOf = async (id: string) => (await requestRow(pool, id))?.document_digest ?? null;

const decide = async (c: string, requestId: string, by: string, decision = 'approved', sub = by.toLowerCase()) => {
  const expected = await digestOf(requestId);
  return asRole(pool, 'app_user', c, { sub },
    async (cl) => (await decideFn(cl, c, requestId, decision, by, expected)).rows, true);
};

/** 872's approval_request_decide, exactly as that file defines it. */
const decide872 = (() => {
  const text = readFileSync('scripts/migrations/sql/872_approval_request_definer_writes.sql', 'utf8');
  const start = text.indexOf('CREATE OR REPLACE FUNCTION public.approval_request_decide(');
  const end = text.indexOf('\n$$;', start);
  if (start < 0 || end < 0) throw new Error('872 no longer defines approval_request_decide');
  return text.slice(start, end + 4);
})();

/** The SQLSTATE 872's body answers for `by` deciding, in a transaction that is rolled back (872's body goes with it). */
async function outcomeUnder872(c: string, requestId: string, by: string, decision: string): Promise<string> {
  const expected = await digestOf(requestId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(decide872);
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)",
      [JSON.stringify({ role: 'authenticated', sub: by.toLowerCase(), session_id: crypto.randomUUID() })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [c]);
    return await outcome(decideFn(client, c, requestId, decision, by, expected));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('872 (before 1050): an upper-cased decider was already refused, by the role check, not the self check', () => {
  it('the requester approving and withdrawing, and another owner approving: RA008 each, nothing decided', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.m });
    expect(await outcomeUnder872(f.c, f.requestId, up(u.b), 'approved')).toBe('RA008');
    expect(await outcomeUnder872(f.c, f.requestId, up(u.b), 'rejected')).toBe('RA008');
    expect(await outcomeUnder872(f.c, f.requestId, up(u.a), 'approved')).toBe('RA008');
    expect((await requestRow(pool, f.requestId))?.status).toBe('pending');
  });
});

describe('approval_request_decide (1050) reads the decider without case', () => {
  it('the requester, upper-cased, approving their own request while another owner could: RA001', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.m });
    expect(await outcome(decide(f.c, f.requestId, up(u.b)))).toBe('RA001');
    expect((await requestRow(pool, f.requestId))?.status).toBe('pending');
  });

  it('the requester, upper-cased, withdrawing: a self-reject, recorded under the stored spelling', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.m });
    const [row] = await decide(f.c, f.requestId, up(u.b), 'rejected');
    expect(row).toMatchObject({ status: 'rejected', decided_by: u.b });
  });

  it("the content's author, upper-cased: RA001", async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(decide(f.c, f.requestId, up(u.a)))).toBe('RA001');
    expect((await requestRow(pool, f.requestId))?.status).toBe('pending');
  });

  it('another owner, upper-cased, still approves; decided_by is the stored id', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.m });
    const [row] = await decide(f.c, f.requestId, up(u.a));
    expect(row).toMatchObject({ status: 'approved', decided_by: u.a, requested_by: u.b });
  });

  it('another owner with an upper-cased JWT subject as well still approves', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.m });
    const [row] = await decide(f.c, f.requestId, up(u.a), 'approved', up(u.a));
    expect(row).toMatchObject({ status: 'approved', decided_by: u.a });
  });

  it('Q2: a sole owner, upper-cased, approves their own request and the audit row names the stored id', async () => {
    const f = await pendingBill(pool, tokens, u, companies,
      { members: [[u.a, 'owner'], [u.m, 'manager']], creator: u.a, requester: u.a });
    const [row] = await decide(f.c, f.requestId, up(u.a));
    expect(row).toMatchObject({ status: 'approved', decided_by: u.a, requested_by: u.a });
    const { rows } = await pool.query(
      "SELECT user_id FROM audit_log WHERE entity_type = 'approval_request' AND entity_id = $1", [f.requestId]);
    expect(rows).toEqual([{ user_id: u.a }]);
  });

  it('an under-rank decider, upper-cased, is refused on rank (RA002), as in lower case', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(decide(f.c, f.requestId, up(u.m)))).toBe('RA002');
  });
});

describe('approval_request_raise (1050) reads the requester without case', () => {
  it('raised upper-cased: the row and roster are the stored id, and that requester may not then approve it (RA001)', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.m });
    const lowerRoster = (await pool.query('SELECT approver_roster FROM approval_requests WHERE id = $1', [f.requestId]))
      .rows[0].approver_roster;
    await decide(f.c, f.requestId, u.b, 'rejected'); // withdraw the route's request, so a new one can be raised
    const billId = (await pool.query('SELECT document_id FROM approval_requests WHERE id = $1', [f.requestId])).rows[0].document_id;
    const [raised] = await asRole(pool, 'app_user', f.c, { sub: u.b },
      async (cl) => (await raiseFn(cl, f.c, 'supplier_invoice', billId, f.ownerRule, up(u.b))).rows, true);
    expect(raised).toMatchObject({ status: 'pending', requested_by: u.b });
    expect(raised.approver_roster).toEqual(lowerRoster);
    expect(await outcome(decide(f.c, raised.id, u.b))).toBe('RA001');
    expect(await outcome(decide(f.c, raised.id, up(u.b)))).toBe('RA001');
  });
});

describe('a case-twin membership row never lends its role (breaker round 1)', () => {
  it("decide: a manager beside an OWNER row under the upper-cased spelling of their id is refused on rank (RA002), as 872 refused", async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.v });
    await plantTwin(f.c, u.m, 'owner');
    expect(await outcomeUnder872(f.c, f.requestId, u.m, 'approved')).toBe('RA002');
    expect(await outcome(decide(f.c, f.requestId, u.m))).toBe('RA002');
    expect(await outcome(decide(f.c, f.requestId, up(u.m)))).toBe('RA002');
    expect((await requestRow(pool, f.requestId))?.status).toBe('pending');
  });

  it("raise: the roster records the requester's own role, not an owner twin's", async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.v, requester: u.m });
    await decide(f.c, f.requestId, u.m, 'rejected');
    await plantTwin(f.c, u.m, 'owner');
    const billId = (await pool.query('SELECT document_id FROM approval_requests WHERE id = $1', [f.requestId])).rows[0].document_id;
    const [raised] = await asRole(pool, 'app_user', f.c, { sub: u.m },
      async (cl) => (await raiseFn(cl, f.c, 'supplier_invoice', billId, f.ownerRule, up(u.m))).rows, true);
    expect(raised).toMatchObject({ status: 'pending', requested_by: u.m });
    expect(raised.approver_roster.requester_role).toBe('manager');
  });
});
