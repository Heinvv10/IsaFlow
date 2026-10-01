// Ported from the adversarial round on PR #593 at 2ce8f234d (brk-593, claim 3, 5 and 6); each case asserts
// the claim, so it was RED where the breaker broke it. Changes from the breaker's file are marked "Ported note".
// brk-593 claims 3 (a refusal writes nothing), 5 (placement rule), 6 (stale page) against the save
// and the other changed routes. Each test asserts the claim; a failure is a break.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { brkFixture, show, sleep } from './w2-28-brk593.helpers';
import coa from '../../pages/api/accounting/chart-of-accounts';
import coaDetail from '../../pages/api/accounting/chart-of-accounts-detail';
import bankAccounts from '../../pages/api/accounting/bank-accounts';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import coaImport from '../../pages/api/accounting/migration/chart-of-accounts';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

const fx = brkFixture('BRK593C5');
const other = brkFixture('BRK593C5B');
const { CO, USER, ins } = fx;
const id = () => randomUUID();
const R = { AR: id(), BANK: id(), VATIN: id(), VATOUT: id(), AP: id(), RE: id(), OBE: id(), REV: id(), EXP: id() };
const E = { X: id(), OTH: id(), INV: id(), BANK2: id(), INACT: id(), HDR: id(), HC: id(), EXPX: id(), LIAB: id(), EQ: id(), FOREIGN: id() };
const ROLE_ROWS: [string, string, string, string][] = [
  [R.AR, '1120', 'asset', 'receivable'], [R.BANK, '1110', 'asset', 'bank'], [R.VATIN, '1140', 'asset', 'vat_input'],
  [R.VATOUT, '2120', 'liability', 'vat_output'], [R.AP, '2100', 'liability', 'payable'], [R.RE, '3200', 'equity', 'retained_earnings'],
  [R.OBE, '3300', 'equity', 'opening_balance_equity'], [R.REV, '4000', 'revenue', 'default_revenue'], [R.EXP, '5000', 'expense', 'default_expense'],
];
const EXPECTED_TYPE: Record<string, string> = Object.fromEntries(ROLE_ROWS.map(([, , t, s]) => [s, t]));
const save = (mappings: unknown, loaded?: unknown) =>
  fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', loaded === undefined ? { mappings } : { mappings, loaded } as never);

/** Every role invariant of the placement rule, read from committed rows. Empty = all hold. */
async function violations(): Promise<string[]> {
  const rows = (await fx.query(
    `SELECT a.account_code, a.account_type, a.account_subtype, a.is_active,
            EXISTS (SELECT 1 FROM gl_accounts c WHERE c.parent_account_id = a.id) AS has_children
       FROM gl_accounts a WHERE a.company_id = $1 AND a.is_system_account AND a.is_active`, [CO])).rows;
  const out: string[] = [];
  for (const role of Object.keys(EXPECTED_TYPE)) {
    const h = rows.filter((r) => r.account_subtype === role);
    if (h.length !== 1) out.push(`${role}: ${h.length} holders [${h.map((r) => r.account_code)}]`);
    for (const r of h) {
      if (r.account_type !== EXPECTED_TYPE[role]) out.push(`${role}: holder ${r.account_code} is a ${r.account_type}`);
      if (r.has_children) out.push(`${role}: holder ${r.account_code} is a header with children`);
    }
  }
  return out;
}

describe('brk-593 claims 3/5/6: the save', () => {
  beforeAll(async () => { await fx.setup(); await other.setup(); });
  beforeEach(async () => {
    await fx.wipe(); await other.wipe(); clearSystemAccountCache(CO);
    for (const [i, c, t, s] of ROLE_ROWS) await ins(i, c, t, s, true);
    await ins(E.X, '1115', 'asset', null, false);
    await ins(E.OTH, '1116', 'asset', 'other', false);
    await ins(E.INV, '1200', 'asset', 'inventory', false);
    await ins(E.BANK2, '1111', 'asset', 'bank', false);
    await ins(E.INACT, '1117', 'asset', null, false, { active: false });
    await ins(E.HDR, '1300', 'asset', null, false);
    await ins(E.HC, '1301', 'asset', null, false, { parent: E.HDR, level: 4 });
    await ins(E.EXPX, '6000', 'expense', 'operating_expense', false);
    await ins(E.LIAB, '2200', 'liability', null, false);
    await ins(E.EQ, '3400', 'equity', null, false);
    await other.ins(E.FOREIGN, '1115', 'asset', null, false);
  });
  afterAll(async () => { await fx.teardown(); await other.teardown(); });

  it('3/5 every adversarial payload is refused (4xx), writes nothing, and leaves every role on one right-typed leaf', async () => {
    const proto = (o: Record<string, unknown>) => JSON.parse(`{"__proto__": ${JSON.stringify(o)}}`);
    const fresh = { accounts_receivable: R.AR };            // an honest `loaded` for the receivable row
    const cases: Record<string, [unknown, unknown?]> = {
      'classified inventory': [{ accounts_receivable: E.INV }, fresh],
      // Ported note: the breaker had this under "allowed" (unknown keys were ignored, 200). Round 6 refuses them.
      'unknown + case-variant keys only': [{ Primary_Bank: R.AR, constructor: E.X, toString: E.X, PRIMARY_BANK: E.INV }, {}],
      'classified bank (non-system)': [{ accounts_receivable: E.BANK2 }, fresh],
      'another role holder': [{ accounts_receivable: R.BANK }, fresh],
      'swap RE and OBE': [{ retained_earnings: R.OBE, opening_balance_equity: R.RE }, { retained_earnings: R.RE, opening_balance_equity: R.OBE }],
      'inactive': [{ accounts_receivable: E.INACT }, fresh],
      'header with children': [{ accounts_receivable: E.HDR }, fresh],
      'wrong type (expense)': [{ accounts_receivable: E.EXPX }, fresh],
      'wrong type (liability as bank)': [{ primary_bank: E.LIAB }, { primary_bank: R.BANK }],
      'another company\'s account': [{ accounts_receivable: E.FOREIGN }, fresh],
      'one account, two roles': [{ accounts_receivable: E.X, primary_bank: E.X }, { accounts_receivable: R.AR, primary_bank: R.BANK }],
      'one account, two roles (case)': [{ accounts_receivable: E.X, primary_bank: E.X.toUpperCase() }, { accounts_receivable: R.AR, primary_bank: R.BANK }],
      'clear with ""': [{ accounts_receivable: '' }, fresh],
      'clear with null': [{ accounts_receivable: null }, fresh],
      'array value': [{ accounts_receivable: [E.X] }, fresh],
      'object value': [{ accounts_receivable: { id: E.X } }, fresh],
      'number value': [{ accounts_receivable: 1115 }, fresh],
      'boolean value': [{ accounts_receivable: true }, fresh],
      'uppercase id': [{ accounts_receivable: E.X.toUpperCase() }, fresh],
      'padded id': [{ accounts_receivable: ` ${E.X} ` }, fresh],
      'not a uuid': [{ accounts_receivable: "x' OR '1'='1" }, fresh],
      'valid move then a refusal in the same payload': [{ primary_bank: E.X, accounts_receivable: E.INV, petty_cash: E.OTH }, { primary_bank: R.BANK, accounts_receivable: R.AR }],
      'unmanaged write then a refusal': [{ sales_discount: E.OTH, rounding: E.OTH, accounts_payable: E.EXPX }, { accounts_payable: R.AP }],
      'stale: loaded omitted': [{ accounts_receivable: E.X }],
      'stale: loaded {}': [{ accounts_receivable: E.X }, {}],
      'stale: loaded null': [{ accounts_receivable: E.X }, null],
      'stale: loaded partial': [{ accounts_receivable: E.X, primary_bank: E.OTH }, { accounts_receivable: R.AR }],
      'stale: loaded lies (other account)': [{ accounts_receivable: E.X }, { accounts_receivable: E.OTH }],
      'stale: loaded names the chosen account': [{ accounts_receivable: E.X }, { accounts_receivable: E.X }],
      'stale: loaded array': [{ accounts_receivable: E.X }, { accounts_receivable: [R.AR] }],
      'stale: loaded uppercase': [{ accounts_receivable: E.X }, { accounts_receivable: R.AR.toUpperCase() }],
      'stale: loaded via __proto__': [{ accounts_receivable: E.X }, proto({ accounts_receivable: R.AR })],
      'mappings via __proto__ + managed refusal': [{ ...proto({ accounts_receivable: E.INV }), accounts_payable: E.EXPX }, { accounts_payable: R.AP }],
      'loaded is an array': [{ accounts_receivable: E.X }, [R.AR]],
      'loaded is a string': [{ accounts_receivable: E.X }, JSON.stringify(fresh)],
      'loaded is a number': [{ accounts_receivable: E.X }, 7],
      'mappings is an array': [[E.X]],
      'mappings is a string': [JSON.stringify({ accounts_receivable: E.X })],
      'mappings is null': [null],
    };
    const h0 = await fx.hash(); const hOther0 = await other.hash(other.CO);
    const table: Record<string, unknown> = {}; const bad: string[] = [];
    for (const [name, [mappings, loaded]] of Object.entries(cases)) {
      const r = await save(mappings, loaded);
      const wrote = (await fx.hash()) !== h0; const v = await violations();
      table[name] = { status: r.statusCode, wrote, violations: v };
      if (r.statusCode < 400 || r.statusCode >= 500 || wrote || v.length) bad.push(name);
      if (wrote) { await fx.wipe(); break; }
    }
    show('3/5 refusals', table);
    expect(await other.hash(other.CO)).toBe(hOther0);
    expect(bad).toEqual([]);
  }, 120_000);

  it('5 payloads the rule allows succeed and still leave every role on exactly one right-typed leaf', async () => {
    const steps: [string, unknown, unknown][] = [
      ['receivable -> unclassified', { accounts_receivable: E.X }, { accounts_receivable: R.AR }],
      ['receivable back -> former holder', { accounts_receivable: R.AR }, { accounts_receivable: E.X }],
      ['bank -> classified other', { primary_bank: E.OTH }, { primary_bank: R.BANK }],
      ['bank -> classified bank (non-system)', { primary_bank: E.BANK2 }, { primary_bank: E.OTH }],
      ['same-holder no-op with a lying loaded', { accounts_receivable: R.AR }, { accounts_receivable: E.INV }],
    ];
    const table: Record<string, unknown> = {}; const bad: string[] = [];
    for (const [name, mappings, loaded] of steps) {
      const r = await save(mappings, loaded); const v = await violations();
      table[name] = { status: r.statusCode, violations: v };
      if (r.statusCode !== 200 || v.length) bad.push(name);
    }
    show('5 allowed', { table, rows: (await fx.rows()).filter((r) => r.sys) });
    expect(bad).toEqual([]);
  });

  it('5 a save must not leave a role on a header: a child created under the chosen account while the save is in flight', async () => {
    // Hold the save after its placement checks: it next takes the company's shared VAT key (570).
    const c: PoolClient = await fx.connect();
    await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 570))', [CO]);
    let child: { statusCode: number; body: Record<string, unknown> };
    try {
      const saving = save({ accounts_receivable: E.X }, { accounts_receivable: R.AR });
      for (let i = 0; i < 100; i++) {
        const n = (await fx.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%pg_advisory_xact_lock_shared%'")).rows[0].n;
        if (n > 0) break; await sleep(50);
      }
      child = await fx.call(coa, 'POST', '/api/accounting/chart-of-accounts',
        { accountCode: '1115A', accountName: 'child of the chosen account', accountType: 'asset', normalBalance: 'debit', parentAccountId: E.X });
      await c.query('ROLLBACK');
      const s = await saving;
      const v = await violations();
      show('5 header race', { childCreate: child.statusCode, save: s.statusCode, violations: v, rows: (await fx.rows()).filter((r) => ['1115', '1115A', '1120'].includes(r.code)) });
      expect(v).toEqual([]);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  }, 30_000);

  it('5 (not a save) after a role is placed, nothing stops the holder becoming a header', async () => {
    const create = await fx.call(coa, 'POST', '/api/accounting/chart-of-accounts',
      { accountCode: '1120A', accountName: 'child of the receivable holder', accountType: 'asset', normalBalance: 'debit', parentAccountId: R.AR });
    const reparent = await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: E.LIAB, parentAccountId: R.AP });
    const bankGroup = await fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: E.BANK2, parentAccountId: R.BANK });
    const v = await violations();
    show('5 header after the fact', { create: create.statusCode, reparent: reparent.statusCode, bankGroup: bankGroup.statusCode, violations: v });
    expect(v).toEqual([]);
  });

  it('3 refusals on the other changed routes write nothing', async () => {
    const session = await createSession(CO, 'sage', USER);
    await fx.query('UPDATE gl_accounts SET is_active = false, is_system_account = true, account_subtype = $2 WHERE id = $1', [E.INACT, 'bank']);
    const h0 = await fx.hash();
    const calls: [string, () => Promise<{ statusCode: number; body: Record<string, unknown> }>][] = [
      ['PUT coa: deactivate holder', () => fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: R.BANK, isActive: false, accountName: 'renamed' })],
      ['PUT coa: reclassify holder', () => fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: R.BANK, accountSubtype: 'inventory', accountName: 'renamed' })],
      ['PUT coa: clear holder subtype', () => fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: R.BANK, accountSubtype: null })],
      ['PUT coa: reparent (writes) then deactivate holder (refused)', () => fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: R.BANK, parentAccountId: null, isActive: false })],
      ['PUT coa: reactivate rival', () => fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: E.INACT, isActive: true, accountName: 'renamed' })],
      ['PUT detail: deactivate holder', () => fx.call(coaDetail, 'PUT', '/api/accounting/chart-of-accounts-detail', { id: R.AR, isActive: false, accountName: 'renamed' })],
      ['DELETE detail: holder', () => fx.call(coaDetail, 'DELETE', '/api/accounting/chart-of-accounts-detail', { id: R.AR })],
      ['PUT bank: deactivate primary', () => fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: R.BANK, isActive: false, accountName: 'renamed', parentAccountId: null })],
      ['PUT bank: reactivate rival', () => fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: E.INACT, isActive: true, accountName: 'renamed' })],
      ['PUT bank: bad group after valid fields', () => fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: E.BANK2, accountName: 'renamed', parentAccountId: E.X })],
      ['COA import: role map onto another role\'s holder', () => fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id,
        accounts: [{ accountCode: '1120', accountName: 'renamed', accountType: 'asset', normalBalance: 'debit' }, { accountCode: '9999', accountName: 'new', accountType: 'expense', normalBalance: 'debit', accountSubtype: 'operating_expense' }],
        systemAccountMap: { bank: '1120' } })],
      ['COA import: one code for two roles', () => fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id,
        accounts: [{ accountCode: '1115', accountName: 'renamed', accountType: 'asset', normalBalance: 'debit' }], systemAccountMap: { bank: '1115', receivable: '1115' } })],
    ];
    const table: Record<string, unknown> = {}; const bad: string[] = [];
    for (const [name, fn] of calls) {
      const r = await fn(); const wrote = (await fx.hash()) !== h0;
      const refused = r.statusCode >= 400 || (Array.isArray((r.body as { data?: { errors?: unknown[] } }).data?.errors) && (r.body as { data: { imported: number } }).data.imported === 0);
      table[name] = { status: r.statusCode, refused, wrote };
      if (!refused || wrote) bad.push(name);
      if (wrote) break;
    }
    show('3 other routes', table);
    expect(bad).toEqual([]);
  }, 60_000);
});
