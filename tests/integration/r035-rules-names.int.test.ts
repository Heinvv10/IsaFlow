/**
 * R-035 PR A, folded in from the round-3 adversarial review (prA-adv-r3): the
 * whole-cent check, the name bound (a name must show at least one visible
 * character, REPRO D), trimming on POST and on a PUT rename vs the starter's
 * idempotency, and the documentType allow-list vs the legacy refusal (a
 * non-string gets the allow-list message, REPRO E).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import approvalRules from '../../pages/api/accounting/approval-rules';
import { checkApproval } from '../../src/modules/accounting/services/gl/approvalService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, cleanup, createUser, newCompany, plantRule } from './r035-approval.helpers';
import { inRequest } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { owner: '', admin: '' };

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanup(pool, companies, Object.values(u)));

const URL = '/api/accounting/approval-rules';
const call = (as: string, c: string, method: string, body: unknown) => callRoute(approvalRules, tokens[as]!, c, method, body, URL);
const company = () => newCompany(pool, [[u.owner, 'owner'], [u.admin, 'admin']], companies);
const rows = async (c: string) => (await pool.query(
  `SELECT name, document_type, condition_operator, condition_value::TEXT AS v, is_active FROM approval_rules WHERE company_id = $1 ORDER BY created_at`, [c])).rows;
const audits = async (c: string) => (await pool.query(
  `SELECT entity_ref FROM audit_log WHERE company_id = $1 AND entity_type = 'approval_rule'`, [c])).rows;
const status = (res: { state: { statusCode: number } }) => res.state.statusCode;
const msg = (res: { state: { body: unknown } }) => (res.state.body as { error?: { message?: string } }).error?.message ?? '';
const base = { name: 'Adv', documentType: 'supplier_invoice', conditionOperator: 'greater_than', approverRole: 'admin' };

describe('whole cents: accepted values are stored exactly, sub-cent values are 400', () => {
  it.each([
    ['10.10', 10.10, '10.10'], ['0.29', 0.29, '0.29'], ['4.35', 4.35, '4.35'], ['1.15', 1.15, '1.15'],
    ['9999999999999.99', 9999999999999.99, '9999999999999.99'], ['0', 0, '0.00'], ['-0', -0, '0.00'],
    ['123456789012.34', 123456789012.34, '123456789012.34'],
  ] as [string, number, string][])('POST %s → 200, stored %s', async (_l, v, stored) => {
    const c = await company();
    expect(status(await call(u.owner, c, 'POST', { ...base, conditionValue: v }))).toBe(200);
    expect((await rows(c))[0].v).toBe(stored);
  });

  it.each([['0.1+0.2', 0.1 + 0.2], ['1e-7', 1e-7], ['5e-324', 5e-324], ['1.005', 1.005], ['999.995', 999.995],
    ['0.001', 0.001]] as [string, number][])('POST %s → 400, nothing written', async (_l, v) => {
    const c = await company();
    const res = await call(u.owner, c, 'POST', { ...base, conditionValue: v });
    expect(status(res)).toBe(400);
    expect(msg(res)).toMatch(/at most 2 decimals/);
    expect(await rows(c)).toEqual([]);
  });

  it('a whole-cent operator switch that only WIDENS ("≥ 1000" → "> 999.99") is allowed and still gates R1 000.00', async () => {
    const c = await company();
    const id = await plantRule(pool, c, 'admin', { operator: 'greater_equal', value: 1000 });
    expect(status(await call(u.admin, c, 'PUT', { id, conditionOperator: 'greater_than', conditionValue: 999.99 }))).toBe(200);
    const m = await inRequest(pool, u.admin, c, () => checkApproval(c, 'supplier_invoice', crypto.randomUUID(), 1000));
    expect(m.matchedRule).not.toBeNull();
  });

  it('control: "> 999.99" → "≥ 1000" narrows and is refused 403 at the rule\'s own rank', async () => {
    const c = await company();
    const id = await plantRule(pool, c, 'admin', { operator: 'greater_than', value: 999.99 });
    expect(status(await call(u.admin, c, 'PUT', { id, conditionOperator: 'greater_equal', conditionValue: 1000 }))).toBe(403);
  });
});

describe('names', () => {
  it.each([
    ['zero-width space only', '​'], ['zero-width joiner + word joiner', '‍⁠'],
    ['BOM only', '﻿'], ['NBSP only', ' '], ['ideographic space only', '　'], ['line separator', ' '],
  ])('a name that renders blank (%s) is a 400', async (_l, name) => {
    const c = await company();
    const res = await call(u.owner, c, 'POST', { ...base, name, conditionValue: 10 });
    expect(status(res), JSON.stringify((await rows(c)).map((r) => r.name))).toBe(400);
  });

  it('unicode whitespace around a name is trimmed on POST', async () => {
    const c = await company();
    expect(status(await call(u.owner, c, 'POST', { ...base, name: '　 Big bills ', conditionValue: 10 }))).toBe(200);
    expect((await rows(c))[0].name).toBe('Big bills');
  });

  it.each([
    ['100 é (1 unit each)', 'é'.repeat(100), 200], ['101 é', 'é'.repeat(101), 400],
    ['50 emoji = 100 UTF-16 units', '😀'.repeat(50), 200], ['100 decomposed e+◌́ = 200 units', 'é'.repeat(100), 400],
  ] as [string, string, number][])('%s → %i, and an accepted name is audited without a 500', async (_l, name, want) => {
    const c = await company();
    const res = await call(u.owner, c, 'POST', { ...base, name, conditionValue: 10 });
    expect(status(res), JSON.stringify(res.state.body)).toBe(want);
    if (want === 200) expect((await audits(c))[0].entity_ref).toBe(name);
  });

  it('PUT rename to the same name padded is a no-op on the stored name; the starter still skips it', async () => {
    const c = await company();
    expect(status(await call(u.owner, c, 'POST', { action: 'starter', rules: [{ documentType: 'supplier_invoice' }] }))).toBe(200);
    const id = (await pool.query(`SELECT id FROM approval_rules WHERE company_id = $1`, [c])).rows[0].id;
    expect(status(await call(u.owner, c, 'PUT', { id, name: '  Large supplier invoices ' }))).toBe(200);
    const again = await call(u.owner, c, 'POST', { action: 'starter', rules: [{ documentType: 'supplier_invoice' }] });
    expect((again.state.body as { data: { created: unknown[] } }).data.created).toEqual([]);
    expect((await rows(c)).map((r) => r.name)).toEqual(['Large supplier invoices']);
  });

  it('a manual POST named like a starter rule with padding is trimmed, so the starter skips that type (by design: same (type, name))', async () => {
    const c = await company();
    expect(status(await call(u.owner, c, 'POST', { ...base, name: ' Large supplier invoices ', conditionValue: 10 }))).toBe(200);
    const res = await call(u.owner, c, 'POST', { action: 'starter', rules: [{ documentType: 'supplier_invoice' }] });
    expect((res.state.body as { data: { skipped: unknown[] } }).data.skipped).toHaveLength(1);
  });
});

describe('documentType: legacy refusal first, then the allow-list; each with its own message', () => {
  it.each(['credit_note', 'payment', 'journal_entry'])('legacy %s → the legacy message', async (documentType) => {
    const c = await company();
    const res = await call(u.owner, c, 'POST', { ...base, documentType, conditionValue: 10 });
    expect(status(res)).toBe(400);
    expect(msg(res)).toMatch(/no longer govern/);
  });

  it.each([
    ['["credit_note"] (array of a legacy name)', ['credit_note']], ['"Credit_Note"', 'Credit_Note'], ['"__proto__"', '__proto__'],
    ['"constructor"', 'constructor'], ['"toString"', 'toString'], ['5', 5], ['" supplier_invoice"', ' supplier_invoice'],
  ] as [string, unknown][])('%s → the allow-list message, nothing created', async (_l, documentType) => {
    const c = await company();
    const res = await call(u.owner, c, 'POST', { ...base, documentType, conditionValue: 10 });
    expect(status(res), JSON.stringify(res.state.body)).toBe(400);
    expect(msg(res)).toMatch(/^documentType must be one of/);
    expect(await rows(c)).toEqual([]);
  });
});

// Review round 4 (prA-adv-r4, REPRO F/G): blank characters outside \s/Cf, and
// control characters. NUL reached Postgres as a 500 with the raw pg message.
describe('names: fillers, marks and control characters (review round 4)', () => {
  it.each([
    ['HANGUL FILLER U+3164 (Lo)', 'ㅤ'], ['HANGUL CHOSEONG FILLER U+115F', 'ᅟ'],
    ['HANGUL JUNGSEONG FILLER U+1160', 'ᅠ'], ['HALFWIDTH HANGUL FILLER U+FFA0', 'ﾠ'],
    ['BRAILLE PATTERN BLANK U+2800 (So)', '⠀'], ['COMBINING GRAPHEME JOINER U+034F (Mn)', '͏'],
    ['VARIATION SELECTOR-16 U+FE0F (Mn)', '️'], ['control U+0001 (Cc)', '\u0001'],
  ])('POST a name that renders blank (%s) is a 400', async (_l, name) => {
    const c = await company();
    const res = await call(u.owner, c, 'POST', { ...base, name, conditionValue: 10 });
    expect(status(res), JSON.stringify((await rows(c)).map((r) => r.name))).toBe(400);
  });

  it.each([['POST', 'a\u0000b'], ['PUT', 'a\u0000b'], ['POST', 'Big\u0007bills'], ['PUT', 'Big\tbills']])(
    '%s a name holding a control character is a 400, never the raw pg 500', async (method, name) => {
      const c = await company();
      const body = method === 'POST' ? { ...base, name, conditionValue: 10 }
        : { id: await plantRule(pool, c, 'admin', { operator: 'greater_than', value: 5 }), name };
      const res = await call(u.owner, c, method, body);
      expect(status(res), JSON.stringify(res.state.body)).toBe(400);
      expect(msg(res)).toBe('name must be 1 to 100 characters of visible text, with no control characters');
    });

  it.each([['a visible letter beside a filler', 'Billsㅤ'], ['a decomposed é', 'Café bills'], ['an emoji', '\u{1F4B0} bills']])(
    'a name with %s is accepted', async (_l, name) => {
      const c = await company();
      expect(status(await call(u.owner, c, 'POST', { ...base, name, conditionValue: 10 }))).toBe(200);
    });
});
