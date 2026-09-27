/**
 * R-048: an actor may not weaken the rule that governs their own level.
 *
 * K-043's ratchet (migration 669) pins a PENDING request to the role it was
 * raised under. It says nothing about the rule itself, and rule authority let an
 * actor edit any rule at or below their own rank — so an admin could hand an
 * ADMIN-level rule down to manager, withdraw their request, re-raise it, and the
 * new request snapshotted the lowered role. A manager then approved it: 200.
 *
 * Decision (Hein): WEAKENING a rule — lowering its role, deactivating it,
 * deleting it, or narrowing the amounts it matches — needs a rank STRICTLY
 * ABOVE the rule's current level. Strengthening and neutral edits keep the old
 * at-or-above rule. The one exception is the top of a company's ladder: an
 * owner may weaken an owner-level rule, or nobody in the company ever could.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import approvalRules from '../../pages/api/accounting/approval-rules';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { deletePlantedDocuments, plantDocument } from './approval-document.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const admin = crypto.randomUUID();
const manager = crypto.randomUUID();
const owner = crypto.randomUUID();
const users = [admin, manager, owner];
const tokens: Record<string, string> = {};

const sign = (id: string) => new SignJWT({ sub: id, aal: 'aal2', session_id: crypto.randomUUID() })
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(process.env.JWT_SECRET));

beforeAll(async () => {
  for (const id of users) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [id, `${id}@test.local`]);
    tokens[id] = await sign(id);
  }
});

/** Own company per case: rules match by document type across the whole company. */
async function newCompany(): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, `R048 ${id.slice(0, 8)}`]);
  for (const [userId, role] of [[admin, 'admin'], [manager, 'manager'], [owner, 'owner']] as const) {
    await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [id, userId, role]);
  }
  companies.push(id);
  return id;
}

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM approval_requests WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM approval_rules WHERE company_id=ANY($1)', [companies]);
    await deletePlantedDocuments(pool, companies);
    await pool.query('DELETE FROM company_users WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [companies]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [users]);
  } finally {
    await pool.end();
  }
});

function call(handler: typeof approvalRules, as: string, companyId: string, method: string, body: unknown) {
  const req = request({ 'sb-access-token': tokens[as]!, active_company_id: companyId }, method) as never as {
    body: unknown; query: Record<string, string>; url: string;
  };
  req.body = body;
  req.query = {};
  req.url = '/api/accounting/approval-rules';
  const result = response();
  return handler(req as never, result.res).then(() => result);
}

const reasonOf = (result: Awaited<ReturnType<typeof call>>) =>
  (result.state.body as { error?: { details?: { reason?: string } } }).error?.details?.reason;
const authorityReasonOf = (result: Awaited<ReturnType<typeof call>>) =>
  (result.state.body as { error?: { details?: { authorityReason?: string } } }).error?.details?.authorityReason;

async function plantRule(companyId: string, approverRole: string, operator = 'any', value = 0): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
     VALUES($1,$2,'r048 rule','supplier_invoice','amount',$3,$4,$5,true)`, [id, companyId, operator, value, approverRole]);
  return id;
}

const RULE_COLUMNS = 'name, condition_operator, condition_value::FLOAT AS condition_value, approver_role, is_active';
const ruleState = async (id: string) =>
  (await pool.query(`SELECT ${RULE_COLUMNS} FROM approval_rules WHERE id=$1`, [id])).rows[0] ?? null;

/** Sends one edit (a PUT body, or 'delete') as `as` against a freshly planted rule. */
async function attempt(as: string, rule: { role: string; operator?: string; value?: number }, change: Record<string, unknown> | 'delete') {
  const company = await newCompany();
  const id = await plantRule(company, rule.role, rule.operator, rule.value);
  const before = await ruleState(id);
  const res = change === 'delete'
    ? await call(approvalRules, as, company, 'DELETE', { id })
    : await call(approvalRules, as, company, 'PUT', { id, ...change });
  return { res, before, after: await ruleState(id) };
}

const WEAKENINGS: [string, { role: string; operator?: string; value?: number }, Record<string, unknown> | 'delete'][] = [
  ['lowering its role', { role: 'admin' }, { approverRole: 'manager' }],
  ['deactivating it', { role: 'admin' }, { isActive: false }],
  ['raising its threshold', { role: 'admin', operator: 'greater_than', value: 1000 }, { conditionValue: 5000 }],
  ['narrowing any to greater_than', { role: 'admin' }, { conditionOperator: 'greater_than', conditionValue: 1000 }],
  ['narrowing greater_equal to greater_than at the same value', { role: 'admin', operator: 'greater_equal', value: 1000 }, { conditionOperator: 'greater_than' }],
  ['deleting it', { role: 'admin' }, 'delete'],
];

describe('R-048 — the reviewer\'s path, end to end', () => {
  it('an admin cannot lower the admin rule, so the re-raised request still needs an admin', async () => {
    const company = await newCompany();
    const rule = await plantRule(company, 'admin');
    const documentId = await plantDocument(pool, company, 'supplier_invoice', 500000, admin);
    const raise = () => call(approvalRequests, admin, company, 'POST', {
      action: 'request', documentType: 'supplier_invoice', documentId,
    });

    expect((await raise()).state.statusCode).toBe(200);
    const first = (await pool.query('SELECT id FROM approval_requests WHERE document_id=$1', [documentId])).rows[0];

    // Step 1 — the lever. Refused, and the rule is exactly as it was.
    const lowered = await call(approvalRules, admin, company, 'PUT', { id: rule, approverRole: 'manager' });
    expect(lowered.state.statusCode).toBe(403);
    expect(reasonOf(lowered)).toBe('RULE_AUTHORITY_REQUIRED');
    expect((await ruleState(rule)).approver_role).toBe('admin');

    // Step 2 — withdraw and re-raise: the new request snapshots the live role.
    const withdrawn = await call(approvalRequests, admin, company, 'POST', { action: 'reject', requestId: first.id });
    expect(withdrawn.state.statusCode).toBe(200);
    expect((await raise()).state.statusCode).toBe(200);
    const second = (await pool.query(
      "SELECT id, required_role FROM approval_requests WHERE document_id=$1 AND status='pending'", [documentId])).rows[0];
    expect(second.id).not.toBe(first.id);
    expect(second.required_role).toBe('admin');

    // Step 3 — the step that was a 200.
    const bypass = await call(approvalRequests, manager, company, 'POST', { action: 'approve', requestId: second.id });
    expect(bypass.state.statusCode).toBe(403);
    expect(reasonOf(bypass)).toBe('APPROVER_ROLE_REQUIRED');
  });
});

describe('R-048 — weakening needs a rank strictly above the rule', () => {
  it.each(WEAKENINGS)('refuses an admin %s on an admin-level rule and leaves it unchanged', async (_label, rule, change) => {
    const { res, before, after } = await attempt(admin, rule, change);
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('RULE_AUTHORITY_REQUIRED');
    // The admin HOLDS the rule's rank; what they lack is the rank above it.
    expect(authorityReasonOf(res)).toBe('WEAKENING_REQUIRES_HIGHER_RANK');
    expect(after).toEqual(before);
  });

  it.each(WEAKENINGS)('lets the owner go %s on an admin-level rule', async (_label, rule, change) => {
    const { res, before, after } = await attempt(owner, rule, change);
    expect(res.state.statusCode).toBe(200);
    expect(after).not.toEqual(before);
  });

  it.each(WEAKENINGS.map(([label, rule, change]) => [label, { ...rule, role: 'manager' },
    change !== 'delete' && change.approverRole ? { approverRole: 'accountant' } : change] as const))(
    'lets an admin go %s on a manager-level rule', async (_label, rule, change) => {
      const { res, before, after } = await attempt(admin, rule, change);
      expect(res.state.statusCode).toBe(200);
      expect(after).not.toEqual(before);
    });

  it('refuses a manager lowering or deactivating the manager-level rule that governs them', async () => {
    for (const change of [{ approverRole: 'accountant' }, { isActive: false }]) {
      const { res, before, after } = await attempt(manager, { role: 'manager' }, change);
      expect(res.state.statusCode).toBe(403);
      expect(after).toEqual(before);
    }
  });

});

describe('R-048 — the owner is the top of the ladder', () => {
  const OWNER_LEVEL = WEAKENINGS.map(([label, rule, change]) => [label, { ...rule, role: 'owner' },
    change !== 'delete' && change.approverRole ? { approverRole: 'admin' } : change] as const);

  it.each(OWNER_LEVEL)('lets the owner go %s on an owner-level rule', async (_label, rule, change) => {
    const { res, before, after } = await attempt(owner, rule, change);
    expect(res.state.statusCode).toBe(200);
    expect(after).not.toEqual(before);
  });

  it.each(OWNER_LEVEL)('still refuses an admin %s on an owner-level rule', async (_label, rule, change) => {
    const { res, before, after } = await attempt(admin, rule, change);
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('RULE_AUTHORITY_REQUIRED');
    // Below the rule altogether: refused before weakening is even considered.
    expect(authorityReasonOf(res)).toBe('RANK_REQUIRED');
    expect(after).toEqual(before);
  });
});

describe('R-048 — edits that do not weaken keep the at-or-above rule', () => {
  const STRENGTHENINGS: [string, { role: string; operator?: string; value?: number }, Record<string, unknown>][] = [
    ['renaming', { role: 'admin' }, { name: 'r048 renamed' }],
    ['lowering the threshold', { role: 'admin', operator: 'greater_than', value: 1000 }, { conditionValue: 500 }],
    ['widening greater_than to greater_equal', { role: 'admin', operator: 'greater_than', value: 1000 }, { conditionOperator: 'greater_equal' }],
    ['widening to any', { role: 'admin', operator: 'greater_than', value: 1000 }, { conditionOperator: 'any' }],
    ['changing the unused value of an any rule', { role: 'admin' }, { conditionValue: 5000 }],
    ['raising a manager-level rule to admin', { role: 'manager' }, { approverRole: 'admin' }],
  ];

  it.each(STRENGTHENINGS)('lets an admin go %s', async (_label, rule, change) => {
    const { res, before, after } = await attempt(admin, rule, change);
    expect(res.state.statusCode).toBe(200);
    expect(after).not.toEqual(before);
  });
});

describe('R-048 — the rank is read under a row lock', () => {
  it('ranks the level the rule holds when the write lands, not the one it held before a concurrent raise', async () => {
    // An owner's raise of a manager-level rule to admin is in flight, holding the
    // row. The admin's lowering must be judged against 'admin' — the level it
    // will actually overwrite — or it lowers an admin-level rule.
    const company = await newCompany();
    const rule = await plantRule(company, 'manager');
    const raiser = await pool.connect();
    try {
      await raiser.query('BEGIN');
      await raiser.query("UPDATE approval_rules SET approver_role='admin' WHERE id=$1", [rule]);
      const raiserPid = (await raiser.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;

      const lowering = call(approvalRules, admin, company, 'PUT', { id: rule, approverRole: 'accountant' });

      // Window entered: the admin's request is blocked behind the raiser.
      let blocked = 0;
      for (let i = 0; i < 100 && blocked === 0; i++) {
        blocked = Number((await pool.query(
          'SELECT count(*) AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [raiserPid])).rows[0].n);
        if (blocked === 0) await new Promise(r => setTimeout(r, 50));
      }
      expect(blocked).toBeGreaterThan(0);

      await raiser.query('COMMIT');
      const res = await lowering;
      expect(res.state.statusCode).toBe(403);
      expect((await ruleState(rule)).approver_role).toBe('admin');
    } finally {
      await raiser.query('ROLLBACK').catch(() => undefined);
      raiser.release();
    }
  });
});
