/**
 * Bank controls step 2 (Hein, decision 4): reversal gating, through the real
 * bank-transactions-action route.
 *
 * Under enforcement of the arm's type the person who made an allocation may
 * not reverse it (403 ALLOCATOR_MAY_NOT_REVERSE, nothing written) — another
 * member does, and that reversal is audited; the sole approver on the admin
 * floor reverses their own; a "login as" session is refused. Enforcement off,
 * an ungated arm, and a customer receipt (money in) reverse as before, with
 * no audit row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import {
  actionRoute, bankCompany, cleanupBankControlsA, enforce, lineStatus, PAY_TYPES, plantBatch, plantLine, refusalOf,
  type BankCompany,
} from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const sessions: string[] = [];
let a = '';
let b = '';
let act: ReturnType<typeof actionRoute>;

beforeAll(async () => {
  a = await createUser(pool, tokens);
  b = await createUser(pool, tokens);
  act = actionRoute(tokens);
});
afterAll(async () => {
  await pool.query('DELETE FROM impersonation_sessions WHERE session_id = ANY($1)', [sessions]);
  await cleanupBankControlsA(pool, companies, [a, b]);
});

/** A line of a legacy batch (no importer), allocated by `by` before `types` are enforced. */
async function allocated(types: string[], arm: 'account' | 'supplier' | 'customer', opts: {
  members?: [string, string][]; by?: string; amount?: number;
} = {}): Promise<BankCompany & { line: string }> {
  const f = await bankCompany(pool, opts.members ?? [[a, 'admin'], [b, 'admin']], companies);
  const line = await plantLine(pool, f, await plantBatch(pool, f, null), opts.amount ?? (arm === 'customer' ? 800 : -1500));
  const body = arm === 'account' ? { allocationType: 'account', contraAccountId: f.expA }
    : { allocationType: arm, entityId: arm === 'supplier' ? f.supplier : f.customer };
  const res = await act(opts.by ?? a, f.c, { action: 'allocate', bankTransactionId: line, ...body });
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  await enforce(pool, f.c, a, types);
  return { ...f, line };
}
const reverse = (user: string, f: BankCompany & { line: string }) => act(user, f.c, { action: 'reverse', bankTransactionId: f.line });
const audits = async (c: string) => (await pool.query(
  "SELECT user_id, entity_id::TEXT AS entity, changes->'metadata' AS meta FROM audit_log WHERE company_id = $1 AND action = 'reverse'",
  [c])).rows as { user_id: string; entity: string; meta: Record<string, string> }[];
const contras = async (c: string) =>
  (await pool.query("SELECT count(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1 AND reversal_of_id IS NOT NULL", [c]))
    .rows[0].n as number;
const expectAllocatorRefused = (res: Parameters<typeof refusalOf>[0], arm: string) => {
  const r = refusalOf(res);
  expect(r, JSON.stringify(res.state.body)).toMatchObject({ status: 403, reason: 'ALLOCATOR_MAY_NOT_REVERSE' });
  expect(r.message).toBe(`You made this allocation, so while ${arm} approval is on you cannot reverse it yourself. `
    + 'Ask another member to reverse it.');
};

describe('the allocator may not reverse their own allocation', () => {
  it('account arm (manual_journal): refused 403 with nothing written; another member reverses, audited', async () => {
    const f = await allocated(['manual_journal'], 'account');
    expectAllocatorRefused(await reverse(a, f), 'manual-journal');
    expect(await lineStatus(pool, f.line)).toBe('allocated');
    expect(await contras(f.c)).toBe(0);
    expect(await audits(f.c)).toEqual([]);
    expect((await reverse(b, f)).state.statusCode).toBe(200);
    expect(await lineStatus(pool, f.line)).toBe('imported');
    expect(await audits(f.c)).toEqual([{ user_id: b, entity: f.line,
      meta: { allocator: a, armType: 'manual_journal', soleApprover: 'false' } }]);
  });

  it('supplier arm (supplier_payment): refused 403 with nothing written; another member reverses, audited', async () => {
    const f = await allocated(PAY_TYPES, 'supplier');
    expectAllocatorRefused(await reverse(a, f), 'supplier-payment');
    expect(await lineStatus(pool, f.line)).toBe('allocated');
    expect((await pool.query("SELECT status FROM supplier_payments WHERE company_id = $1", [f.c])).rows[0].status).toBe('processed');
    expect((await reverse(b, f)).state.statusCode).toBe(200);
    expect(await audits(f.c)).toEqual([{ user_id: b, entity: f.line,
      meta: { allocator: a, armType: 'supplier_payment', soleApprover: 'false' } }]);
  });

  it('the sole approver on the admin floor reverses their own allocation, audited as such', async () => {
    const f = await allocated(['manual_journal'], 'account', { members: [[a, 'admin'], [b, 'viewer']] });
    expect((await reverse(a, f)).state.statusCode).toBe(200);
    expect(await audits(f.c)).toEqual([{ user_id: a, entity: f.line,
      meta: { allocator: a, armType: 'manual_journal', soleApprover: 'true' } }]);
  });

  it('a "login as" session is refused 403 even for a member who did not allocate it', async () => {
    const f = await allocated(['manual_journal'], 'account');
    const sessionId = crypto.randomUUID();
    sessions.push(sessionId);
    await pool.query('INSERT INTO impersonation_sessions(session_id, actor_user_id, target_user_id) VALUES($1,$2,$3)', [sessionId, a, b]);
    const impersonated = { ...tokens, imp: await new SignJWT({ sub: b, aal: 'aal2', session_id: sessionId })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET)) };
    const res = await actionRoute(impersonated)('imp', f.c, { action: 'reverse', bankTransactionId: f.line });
    expect(refusalOf(res)).toMatchObject({ status: 403, reason: 'IMPERSONATION_FORBIDDEN' });
    expect(await lineStatus(pool, f.line)).toBe('allocated');
  });
});

describe('what reversal gating leaves alone', () => {
  it('enforcement off: the allocator reverses as before, and nothing is audited', async () => {
    const f = await allocated([], 'account');
    expect((await reverse(a, f)).state.statusCode).toBe(200);
    expect(await audits(f.c)).toEqual([]);
  });

  it('an arm whose type is not enforced: the allocator reverses their supplier payment under manual_journal only', async () => {
    const f = await allocated(['manual_journal'], 'supplier');
    expect((await reverse(a, f)).state.statusCode).toBe(200);
    expect(await audits(f.c)).toEqual([]);
  });

  it('a customer receipt is money in: its allocator reverses it with every type enforced, unaudited', async () => {
    const f = await allocated(['manual_journal', ...PAY_TYPES], 'customer');
    expect((await reverse(a, f)).state.statusCode).toBe(200);
    expect(await lineStatus(pool, f.line)).toBe('imported');
    expect(await audits(f.c)).toEqual([]);
  });
});
