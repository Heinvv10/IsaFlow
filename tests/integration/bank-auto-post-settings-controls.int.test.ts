/**
 * Forensic-controls step 2, D (Hein, 2026-10-09, decision 5): the auto-post settings.
 *
 * Every change to bank_auto_post_settings writes an audit_log row with each changed field's before and after; a
 * request that changes nothing writes nothing. Under manual_journal or supplier_payment enforcement (payment_batch
 * is coupled with supplier_payment, so either counts), a WEAKENING change — switching auto-post or its LLM tier on,
 * raising a cap or setting it to 0 (no cap), lowering a minimum confidence — needs `mayWeakenAtLevel` authority
 * against the bank-control role (never below admin) and a person in their own session; otherwise 403
 * WEAKENING_REQUIRES_AUTHORITY with nothing written. Strengthening is always allowed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { log } from '../../src/lib/logger';
import bankAutoPost from '../../pages/api/accounting/bank-auto-post';
import { updateAutoPostSettings } from '../../src/modules/accounting/services/bank/autoPostSettingsService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, cleanup, createUser, newCompany, plantRule, reasonOf } from './r035-approval.helpers';
import { dataOf, impersonationToken, messageOf } from './r035-pr2.helpers';
import { enforcePay, inRequest } from './r035-pr5.helpers';
import { enforceJournals } from './r035-pr6.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { owner: '', admin: '', manager: '' };

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(async () => { await cleanup(pool, companies, Object.values(u)); });

type Enforce = 'none' | 'journal' | 'payment' | 'batch';
type Settings = { enabled: boolean; minConfidence: number; amountCap: number;
  llmEnabled: boolean; llmMinConfidence: number; llmAmountCap: number };
const DEFAULTS: Settings = { enabled: false, minConfidence: 0.9, amountCap: 10000,
  llmEnabled: false, llmMinConfidence: 0.95, llmAmountCap: 2000 };

async function company(enforce: Enforce = 'journal', row: Partial<Settings> | null = DEFAULTS): Promise<string> {
  const c = await newCompany(pool, [[u.owner, 'owner'], [u.admin, 'admin'], [u.manager, 'manager']], companies);
  if (enforce === 'journal') await enforceJournals(pool, c, u.owner);
  if (enforce === 'payment') await enforcePay(pool, c, 'supplier_payment', u.owner);
  if (enforce === 'batch') {
    await pool.query("INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1,'payment_batch',$2)", [c, u.owner]);
  }
  if (row) {
    const s = { ...DEFAULTS, ...row };
    await pool.query(
      `INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence,
         llm_amount_cap, updated_at) VALUES($1,$2,$3,$4,$5,$6,$7, now() - interval '1 day')`,
      [c, s.enabled, s.minConfidence, s.amountCap, s.llmEnabled, s.llmMinConfidence, s.llmAmountCap]);
  }
  return c;
}

const put = (user: keyof typeof u, c: string, body: unknown, token = tokens[u[user]]!) =>
  callRoute(bankAutoPost, token, c, 'PUT', body, '/api/accounting/bank-auto-post');
const stored = async (c: string) => (await pool.query(
  `SELECT enabled, min_confidence::FLOAT8 AS "minConfidence", amount_cap::FLOAT8 AS "amountCap", llm_enabled AS "llmEnabled",
          llm_min_confidence::FLOAT8 AS "llmMinConfidence", llm_amount_cap::FLOAT8 AS "llmAmountCap",
          updated_by::TEXT AS "updatedBy", updated_at AS "updatedAt"
   FROM bank_auto_post_settings WHERE company_id = $1`, [c])).rows[0] as (Settings & { updatedBy: string; updatedAt: Date }) | undefined;
type Audit = { action: string; user_id: string; entity_id: string;
  changes: { fields: { field: string; old: string | null; new: string | null; label: string }[]; metadata: Record<string, string> } };
const audits = async (c: string) => (await pool.query(
  `SELECT action, user_id, entity_id::TEXT AS entity_id, changes FROM audit_log
   WHERE company_id = $1 AND entity_type = 'bank_auto_post_settings' ORDER BY created_at, id`, [c])).rows as Audit[];
const fieldsOf = (a: Audit) => Object.fromEntries(a.changes.fields.map((f) => [f.field, [f.old, f.new]]));
const ok = (res: { state: { statusCode: number; body: unknown } }) =>
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);

// [case, patch, the audited field, the label the refusal names]
const WEAKENING: [string, Partial<Settings>, string, string][] = [
  ['switching auto-post on', { enabled: true }, 'enabled', 'Auto-post enabled'],
  ['switching the LLM tier on', { llmEnabled: true }, 'llmEnabled', 'LLM tier enabled'],
  ['raising the amount cap', { amountCap: 20000 }, 'amountCap', 'Amount cap'],
  ['setting the amount cap to 0 (no cap)', { amountCap: 0 }, 'amountCap', 'Amount cap'],
  ['raising the LLM amount cap', { llmAmountCap: 5000 }, 'llmAmountCap', 'LLM amount cap'],
  ['setting the LLM amount cap to 0 (no cap)', { llmAmountCap: 0 }, 'llmAmountCap', 'LLM amount cap'],
  ['lowering the minimum confidence', { minConfidence: 0.8 }, 'minConfidence', 'Minimum confidence'],
  ['lowering the LLM minimum confidence', { llmMinConfidence: 0.9 }, 'llmMinConfidence', 'LLM minimum confidence'],
];

describe('every change is audited with before and after', () => {
  it('enforcement off: an admin weakens freely; the first write is a create, the next an update, each field old/new', async () => {
    const c = await company('none', null);
    ok(await put('admin', c, { enabled: true, amountCap: 0, minConfidence: 0.75 }));
    expect(await stored(c)).toMatchObject({ ...DEFAULTS, enabled: true, amountCap: 0, minConfidence: 0.75, updatedBy: u.admin });
    ok(await put('manager', c, { llmEnabled: true, llmAmountCap: 9000 }));
    const [first, second] = await audits(c);
    expect(first).toMatchObject({ action: 'create', user_id: u.admin, entity_id: c });
    expect(fieldsOf(first!)).toEqual({ enabled: ['false', 'true'], amountCap: ['10000', '0'], minConfidence: ['0.9', '0.75'] });
    expect(first!.changes.metadata).toMatchObject({ weakening: 'true', enforcedTypes: '' });
    expect(second).toMatchObject({ action: 'update', user_id: u.manager });
    expect(fieldsOf(second!)).toEqual({ llmEnabled: ['false', 'true'], llmAmountCap: ['2000', '9000'] });
    expect(first!.changes.fields.every((f) => f.label.length > 0)).toBe(true);
  });

  it('under enforcement too: a permitted weakening and a strengthening are each audited', async () => {
    const c = await company('journal');
    ok(await put('owner', c, { enabled: true }));
    ok(await put('manager', c, { amountCap: 500 }));
    const rows = await audits(c);
    expect(rows.map((r) => [r.action, r.user_id, r.changes.metadata.weakening, r.changes.metadata.enforcedTypes])).toEqual([
      ['update', u.owner, 'true', 'manual_journal'], ['update', u.manager, 'false', 'manual_journal'],
    ]);
    expect(fieldsOf(rows[1]!)).toEqual({ amountCap: ['10000', '500'] });
  });

  it('a request that changes nothing writes nothing: no row created, no audit, the stored row untouched', async () => {
    const empty = await company('none', null);
    ok(await put('admin', empty, { ...DEFAULTS }));
    expect(await stored(empty)).toBeUndefined();
    const c = await company('journal', { enabled: true });
    const before = await stored(c);
    const res = await put('admin', c, { enabled: true, minConfidence: 0.9, amountCap: 10000 });
    ok(res);
    expect(dataOf<{ settings: Settings }>(res).settings).toEqual({ ...DEFAULTS, enabled: true });
    expect(await stored(c)).toEqual(before);
    expect(await audits(empty)).toEqual([]);
    expect(await audits(c)).toEqual([]);
  });
});

describe('under enforcement a weakening change needs authority above the control role', () => {
  it.each(WEAKENING)('%s: an admin is refused 403 with nothing written; the owner may', async (_label, patch, field, label) => {
    const warn = vi.spyOn(log, 'warn');
    const c = await company('journal');
    const before = await stored(c);
    const refused = await put('admin', c, patch);
    expect(refused.state.statusCode, JSON.stringify(refused.state.body)).toBe(403);
    expect(reasonOf(refused)).toBe('WEAKENING_REQUIRES_AUTHORITY');
    expect(messageOf(refused)).toContain(`(${label})`);
    expect(messageOf(refused)).toMatch(/a role above admin/);
    expect(await stored(c)).toEqual(before);
    expect(await audits(c)).toEqual([]);
    expect(warn.mock.calls.some(([m]) => /auto-post settings/i.test(String(m)))).toBe(true);
    warn.mockRestore();
    ok(await put('owner', c, patch));
    expect(await stored(c)).toMatchObject({ ...DEFAULTS, ...patch, updatedBy: u.owner });
    expect(fieldsOf((await audits(c))[0]!)).toHaveProperty(field);
  });

  it('with no stored row yet, switching on is judged against the defaults the gate reads: refused, no row created', async () => {
    const c = await company('journal', null);
    const res = await put('admin', c, { enabled: true });
    expect(res.state.statusCode).toBe(403);
    expect(await stored(c)).toBeUndefined();
    ok(await put('owner', c, { enabled: true }));
    expect((await audits(c)).map((a) => a.action)).toEqual(['create']);
  });

  it.each([['supplier_payment', 'payment'], ['payment_batch alone', 'batch']] as const)(
    '%s enforcement counts as well', async (_label, enforce) => {
      const c = await company(enforce);
      const res = await put('admin', c, { amountCap: 0 });
      expect(res.state.statusCode).toBe(403);
      expect(await stored(c)).toMatchObject({ amountCap: 10000 });
    });

  it('one weakening field refuses the whole request, strengthening fields with it included', async () => {
    const c = await company('journal');
    const res = await put('admin', c, { amountCap: 100, minConfidence: 0.5 });
    expect(res.state.statusCode).toBe(403);
    expect(messageOf(res)).toContain('(Minimum confidence)');
    expect(messageOf(res)).not.toContain('Amount cap');
    expect(await stored(c)).toMatchObject({ amountCap: 10000, minConfidence: 0.9 });
  });

  it('an owner-level manual-journal rule raises the level to owner: the owner still may (owner level), the message says so', async () => {
    const c = await company('journal');
    await plantRule(pool, c, 'owner', { documentType: 'manual_journal', operator: 'greater_than', value: 1000 });
    const res = await put('admin', c, { llmEnabled: true });
    expect(res.state.statusCode).toBe(403);
    expect(messageOf(res)).toMatch(/the owner role/);
    ok(await put('owner', c, { llmEnabled: true }));
  });

  it('a manager-level rule cannot lower the admin floor, and a rule of a type nobody enforces does not raise it', async () => {
    const c = await company('journal');
    await plantRule(pool, c, 'manager', { documentType: 'manual_journal', operator: 'any' });
    await plantRule(pool, c, 'owner', { documentType: 'supplier_payment', operator: 'any' });
    const res = await put('admin', c, { enabled: true });
    expect(res.state.statusCode).toBe(403);
    expect(messageOf(res)).toMatch(/a role above admin/);
  });

  it('strengthening is always allowed: a manager tightens every field under enforcement', async () => {
    const c = await company('journal', { enabled: true, llmEnabled: true, amountCap: 0, llmAmountCap: 0, minConfidence: 0.8 });
    ok(await put('manager', c, { amountCap: 5000, llmAmountCap: 1000, minConfidence: 0.95, llmMinConfidence: 0.99 }));
    ok(await put('manager', c, { enabled: false, llmEnabled: false }));
    expect(await stored(c)).toMatchObject({ enabled: false, llmEnabled: false, amountCap: 5000, llmAmountCap: 1000,
      minConfidence: 0.95, llmMinConfidence: 0.99, updatedBy: u.manager });
    expect((await audits(c)).map((a) => a.changes.metadata.weakening)).toEqual(['false', 'false']);
  });
});

describe('only a person in their own session may weaken', () => {
  it('a Login-as session is refused 403, even for the owner, with nothing written', async () => {
    const c = await company('journal');
    const res = await put('owner', c, { enabled: true }, await impersonationToken(pool, u.owner, u.admin));
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('IMPERSONATION_FORBIDDEN');
    expect(await stored(c)).toMatchObject({ enabled: false });
    expect(await audits(c)).toEqual([]);
  });

  it('a claim-less context (an agent or a job) cannot weaken, but may strengthen', async () => {
    const c = await company('journal');
    await expect(inRequest(pool, u.owner, c, () => updateAutoPostSettings(c, { amountCap: 0 }, u.owner)))
      .rejects.toMatchObject({ code: 'AGENT_FORBIDDEN', status: 403 });
    expect(await stored(c)).toMatchObject({ amountCap: 10000 });
    expect(await audits(c)).toEqual([]);
    await inRequest(pool, u.owner, c, () => updateAutoPostSettings(c, { amountCap: 50 }, u.owner));
    expect(await stored(c)).toMatchObject({ amountCap: 50 });
    expect(await audits(c)).toHaveLength(1);
  });
});

describe('the route refuses junk 400 before anything is read or written', () => {
  it.each([
    ['a non-boolean enabled', { enabled: 'yes' }],
    ['a string cap', { amountCap: '100' }],
    ['a negative cap', { llmAmountCap: -1 }],
    ['a confidence above 1', { minConfidence: 1.5 }],
    ['a zero confidence', { llmMinConfidence: 0 }],
    ['a confidence finer than the column stores', { minConfidence: 0.955 }],
    ['a cap in fractions of a cent', { amountCap: 10.001 }],
    ['a null field', { enabled: null }],
  ])('%s', async (_label, body) => {
    const c = await company('none');
    const before = await stored(c);
    const res = await put('admin', c, body);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(await stored(c)).toEqual(before);
    expect(await audits(c)).toEqual([]);
  });
});
