/**
 * R-035 N1b (B, migration 881): the SQL allow-lists are the TypeScript ones
 * (blind review of PR #690, M1). 881 spells out the approver roles, the
 * operators, the fields, the offered and legacy document types and the
 * enforceable types; nothing else ties them to their TypeScript constants, so
 * a list widened on one side only would refuse in SQL what the route accepts
 * (or accept a value the route refuses). Here every value of each TypeScript
 * list, and every other value either side might know, is put to the SQL and
 * the answer compared with the TypeScript's.
 *
 * And the rule-name check over the whole Basic Multilingual Plane (L1): SQL
 * and TypeScript agree on every one-character name, except where 881 names
 * its limit: SQL approximates combining marks (\p{M}) by whole blocks, so a
 * mark outside those blocks passes SQL (TypeScript refuses it), and an
 * unassigned code point inside one is refused by SQL (TypeScript, knowing no
 * mark there, accepts it). Any other disagreement fails here.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { APPROVER_ROLES } from '../../src/modules/accounting/services/gl/approvalRank';
import {
  CONDITION_OPERATORS, ENFORCEABLE_TYPES, RULE_FORM_DOCUMENT_TYPES, isRuleName,
} from '../../src/modules/accounting/services/gl/approvalRuleOptions';
import { CONDITION_FIELDS } from '../../src/modules/accounting/services/gl/approvalRuleInput';
import { coupledTypes } from '../../src/modules/accounting/services/gl/approvalEnforcement';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanup, createUser, newCompany } from './r035-approval.helpers';
import { asRole, outcome } from './r035-n1.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const users: string[] = [];
afterAll(() => cleanup(pool, companies, users));

/** What the SQL input check says of one field, by itself ('ok' or the SQLSTATE). */
const input = (args: (string | null)[]) => outcome(pool.query('SELECT approval_rule_assert_input($1, $2, $3, $4, NULL)', args));

/** Every value either side knows, and a few neither does. */
const ALL_TYPES = ['customer_invoice', 'supplier_invoice', 'payment', 'journal_entry', 'credit_note', 'customer_credit_note',
  'supplier_credit_note', 'supplier_payment', 'payment_batch', 'manual_journal', 'supplier_bank_details', 'Supplier_Invoice', 'x'];

describe('each allow-list is the TypeScript one', () => {
  it.each([...APPROVER_ROLES, 'Owner', 'super-admin', 'nobody', ''])('approver role %j', async (role) => {
    expect(await input([null, role, null, null])).toBe(APPROVER_ROLES.includes(role) ? 'ok' : 'RB006');
  });

  it.each([...CONDITION_OPERATORS, 'gt', 'Any', ''])('operator %j', async (op) => {
    expect(await input([null, null, op, null])).toBe((CONDITION_OPERATORS as readonly string[]).includes(op) ? 'ok' : 'RB007');
  });

  it.each([...CONDITION_FIELDS, 'vat', 'Total', ''])('field %j', async (field) => {
    expect(await input([null, null, null, field])).toBe((CONDITION_FIELDS as readonly string[]).includes(field) ? 'ok' : 'RB008');
  });

  it('document types a rule may be created for: the offered ones, the legacy ones refused as legacy', async () => {
    const owner = await createUser(pool, {});
    users.push(owner);
    const c = await newCompany(pool, [[owner, 'owner']], companies);
    const results: Record<string, string> = {};
    for (const type of ALL_TYPES) {
      results[type] = await outcome(asRole(pool, 'app_user', c, { sub: owner }, (cl) => cl.query(
        "SELECT * FROM approval_rule_create($1,$2,'r',$3,NULL,'any',0,'manager')", [c, owner, type])));
    }
    const expected = Object.fromEntries(ALL_TYPES.map((t) => [t,
      (RULE_FORM_DOCUMENT_TYPES as readonly string[]).includes(t) ? 'ok'
        : ['credit_note', 'payment', 'journal_entry'].includes(t) ? 'RB003' : 'RB004']));
    expect(results).toEqual(expected);
  });

  it('types an Enforce switch may turn on: exactly ENFORCEABLE_TYPES', async () => {
    const owner = await createUser(pool, {});
    users.push(owner);
    const c = await newCompany(pool, [[owner, 'owner']], companies);
    const results: Record<string, string> = {};
    for (const type of ALL_TYPES) {
      results[type] = await outcome(asRole(pool, 'app_user', c, { sub: owner }, (cl) => cl.query(
        'SELECT * FROM approval_enforcement_set($1,$2,true,$3)', [c, type, owner])));
    }
    expect(results).toEqual(Object.fromEntries(ALL_TYPES.map((t) => [t,
      (ENFORCEABLE_TYPES as readonly string[]).includes(t) ? 'ok' : 'RB010'])));
  });
});

describe('each SQL list, read from the function body, is exactly its TypeScript constant (adversarial R2-1)', () => {
  /** Every `ARRAY['a', 'b']` literal in `fn`'s body, each as a sorted list (`ARRAY[p_x]`, no literal, is not a list). */
  const arraysIn = async (fn: string) => {
    const { rows: [f] } = await pool.query('SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure($1)', [fn]);
    return [...String(f.prosrc).matchAll(/ARRAY\[([^\]]*)\]/g)]
      .map((m) => [...m[1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!).sort())
      .filter((list) => list.length > 0);
  };
  const sorted = (xs: readonly string[]) => [...xs].sort();

  it('approval_rule_assert_input: the approver roles, operators and fields', async () => {
    const arrays = await arraysIn('public.approval_rule_assert_input(text,text,text,text,numeric)');
    expect(arrays).toEqual(expect.arrayContaining([sorted(APPROVER_ROLES), sorted(CONDITION_OPERATORS), sorted(CONDITION_FIELDS)]));
    expect(arrays).toHaveLength(3);
  });

  it('approval_rule_create: the offered document types', async () => {
    expect(await arraysIn('public.approval_rule_create(uuid,text,text,text,text,text,numeric,text)'))
      .toEqual([sorted(RULE_FORM_DOCUMENT_TYPES)]);
  });

  it('approval_enforcement_set: the enforceable types and the coupled payment pair, and no other list', async () => {
    expect((await arraysIn('public.approval_enforcement_set(uuid,text,boolean,text)')).sort())
      .toEqual([sorted(ENFORCEABLE_TYPES), sorted(coupledTypes('supplier_payment'))].sort());
  });
});

describe('the bank control from a session that cannot be classified (blind L2)', () => {
  it("is refused with the TypeScript's own message (RB012)", async () => {
    const owner = await createUser(pool, {});
    users.push(owner);
    const c = await newCompany(pool, [[owner, 'owner']], companies);
    await expect(asRole(pool, 'app_user', c, { sub: owner, sessionId: null }, (cl) => cl.query(
      "SELECT * FROM approval_enforcement_set($1,'supplier_bank_details',true,$2)", [c, owner]))).rejects.toMatchObject({
      code: 'RB012', message: 'Supplier bank details can only be verified by a person signed in as themselves.' });
  });
});

describe('rule names over the whole Basic Multilingual Plane (blind L1)', () => {
  it('SQL and TypeScript agree on every one-character name, but for the named combining-mark limit', async () => {
    const chars: string[] = [];
    for (let cp = 0x1; cp <= 0xffff; cp++) if (cp < 0xd800 || cp > 0xdfff) chars.push(String.fromCodePoint(cp));
    for (const cp of [0x110bd, 0x1d173, 0xe0001, 0xe0020, 0xe0100, 0x1f600, 0x10000]) chars.push(String.fromCodePoint(cp));
    const { rows } = await pool.query('SELECT x, approval_rule_name_ok(x) AS ok FROM unnest($1::text[]) x', [chars]);
    const disagree = rows.filter((r) => r.ok !== isRuleName(r.x));
    // The named limit, both faces: a mark outside SQL's listed blocks (TS refuses, SQL passes), and an
    // UNASSIGNED code point inside a listed block (SQL treats the whole block as marks; TS sees no mark).
    const outsideLimit = disagree.filter((r) => !((r.ok === true && /^\p{M}$/u.test(r.x))
      || (r.ok === false && /^\p{Cn}$/u.test(r.x))))
      .map((r) => `U+${r.x.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} sql=${r.ok}`);
    expect(outsideLimit).toEqual([]);
    expect(rows).toHaveLength(chars.length);
  });

  it.each(['\u0085', '\u007F', 'a b', '᠎', '\u{E0001}', '\u{1D173}'])('and on %j', async (name) => {
    expect((await pool.query('SELECT approval_rule_name_ok($1) AS ok', [name])).rows[0].ok).toBe(isRuleName(name));
  });
});
