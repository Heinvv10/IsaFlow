// Ported from the adversarial round's fourth pass on PR #593 at 9366d761c (brk-593/pass4); every case HELD there and must
// stay green: reactivation, a company whose data already breaks the rules (it can operate and repair itself), the
// balance-sheet-only sub-account rule, NULL flags. Only the helpers import path changed.
// brk-593 pass 4: reactivation, a company whose data already breaks the rules, the balance-sheet-only sub-account rule, NULL flags.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { brkFixture, show } from './w2-28-brk593.helpers';
import { drainAfterCommit } from '@/lib/afterCommit';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { updateGlAccountTool, createGlAccountTool } from '../../src/lib/mcp/tools/writeGlAccounts';
import { mergeGlAccountsTool } from '../../src/lib/mcp/tools/writeMergeGlAccounts';
import coa from '../../pages/api/accounting/chart-of-accounts';
import coaDetail from '../../pages/api/accounting/chart-of-accounts-detail';
import bankAccounts from '../../pages/api/accounting/bank-accounts';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import coaSeed from '../../pages/api/accounting/coa-seed';
import coaImport from '../../pages/api/accounting/migration/chart-of-accounts';
import migrationRollback from '../../pages/api/accounting/migration-rollback';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { clearSystemAccountCache, getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { ensureOpeningBalanceEquityAccount } from '@/modules/accounting/services/gl/openingBalanceEquityService';
import { SYSTEM_ACCOUNT_KEYS } from '@/modules/accounting/services/gl/systemAccountKeys';

const fx = brkFixture('BRK593P4R');
const { CO, USER, ins, holders } = fx;
const id = () => randomUUID();
const ctx = () => ({ userId: USER, companyId: CO, scopes: ['write:accounts', 'write:post', 'write:journals'], tokenJti: 'brk593', oauthAppId: null }) as never;
const registry = new McpRegistry();
for (const t of [updateGlAccountTool, createGlAccountTool, mergeGlAccountsTool]) registry.register(t);
const mcp = async (name: string, args: Record<string, unknown>) => {
  const tx = await fx.openTx(drainAfterCommit);
  const r = await tx.run(() => registry.call(name, { ...args, idempotency_key: randomUUID() }, ctx()))
    .then((x) => (x.isError ? `refused: ${JSON.stringify(x.content).slice(0, 150)}` : 'ok'), (e: Error) => `THROWN ${e.message.slice(0, 150)}`);
  await tx.commit().catch(() => undefined);
  return r;
};
const st = (r: { statusCode: number; body: Record<string, unknown> }) => r.statusCode === 200 ? 200
  : `${r.statusCode} ${String((r.body as { error?: { message?: string } }).error?.message ?? JSON.stringify(r.body)).slice(0, 150)}`;
const importCoa = async (accounts: unknown[], map: Record<string, unknown>) => {
  const session = await createSession(CO, 'sage', USER);
  const r = await fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id, accounts, systemAccountMap: map });
  const d = (r.body as { data?: { imported?: number; errors?: { message: string }[] } }).data;
  return r.statusCode === 200 && d ? `200 imported ${d.imported}${d.errors?.length ? ` — ${d.errors.map((e) => e.message).join(' | ').slice(0, 170)}` : ''}` : st(r);
};
/** Violations of the rules as now decided: one active holder per role, right type, no BALANCE-SHEET holder with children. */
const violations = async () => (await fx.query(
  `WITH h AS (SELECT * FROM gl_accounts WHERE company_id = $1 AND is_system_account IS TRUE AND is_active IS TRUE AND account_subtype = ANY($2::text[]))
   SELECT account_subtype || ': ' || count(*) || ' holders' AS v FROM h GROUP BY account_subtype HAVING count(*) > 1
   UNION ALL SELECT h.account_subtype || ': holder ' || h.account_code || ' (' || h.account_type || ') is a balance-sheet header' FROM h
     WHERE h.account_type IN ('asset','liability','equity') AND EXISTS (SELECT 1 FROM gl_accounts c WHERE c.parent_account_id = h.id)
   ORDER BY 1`, [CO, [...SYSTEM_ACCOUNT_KEYS]])).rows.map((r) => r.v as string);
const resolve = (key: string) => getSystemAccount(key as never, CO).then((a) => a.accountCode, (e: Error) => e.constructor.name);

const AR = id(); const BANK = id(); const AP = id(); const REV = id(); const EXP = id(); const X = id();
async function base() {
  await fx.wipe(); clearSystemAccountCache(CO);
  await ins(AR, '1120', 'asset', 'receivable', true); await ins(BANK, '1110', 'asset', 'bank', true);
  await ins(AP, '2110', 'liability', 'payable', true); await ins(REV, '4100', 'revenue', 'default_revenue', true);
  await ins(EXP, '5100', 'expense', 'default_expense', true); await ins(X, '1115', 'asset', null, false);
}

describe('brk-593 pass 4: rules', () => {
  beforeAll(fx.setup);
  beforeEach(base);
  afterAll(fx.teardown);

  it('R1 reactivating a former holder: refused when it would be a balance-sheet header, mistyped, or a second holder; string/number isActive refused', async () => {
    const mk = async (code: string, type: string, sub: string, opts: { child?: boolean } = {}) => {
      const a = id(); await ins(a, code, type, sub, true, { active: false });
      if (opts.child) await ins(id(), `${code}C`, type, null, false, { parent: a, level: 4 });
      return a;
    };
    // the roles these would take are EMPTY: remove the live holders of vat_input / vat_output / retained_earnings (none seeded)
    const hdr = await mk('1140', 'asset', 'vat_input', { child: true });               // empty role, has a sub-account
    const mistyped = await mk('2120', 'expense', 'vat_output');                        // empty role, wrong type
    const second = await mk('1105', 'asset', 'bank');                                  // bank is held by 1110
    const incomeHdr = await mk('4190', 'revenue', 'other_income', { child: true });    // empty income-statement role, has a sub-account
    const bankHdr = await mk('1109', 'asset', 'bank', { child: true });
    const out: Record<string, unknown> = {};
    for (const [label, a] of [['bs-header into empty role', hdr], ['mistyped into empty role', mistyped], ['second holder', second], ['income header into empty role', incomeHdr]] as const) {
      out[`${label} / PUT chart`] = st(await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: a, isActive: true }));
      out[`${label} / PUT detail`] = st(await fx.call(coaDetail, 'PUT', '/api/accounting/chart-of-accounts-detail', { id: a, isActive: true }));
      out[`${label} / MCP update`] = await mcp('update_gl_account', { account_id: a, is_active: true });
    }
    await fx.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [BANK]);   // now the bank role is empty
    out['bank header into empty bank role / PUT bank-accounts'] = st(await fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: bankHdr, isActive: true }));
    for (const v of ['true', 1, [true], { a: 1 }, null]) {
      out[`isActive ${JSON.stringify(v)} / PUT chart`] = st(await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: second, isActive: v as never }));
      out[`isActive ${JSON.stringify(v)} / PUT bank`] = st(await fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: second, isActive: v as never }));
      out[`is_active ${JSON.stringify(v)} / MCP`] = await mcp('update_gl_account', { account_id: second, is_active: v });
    }
    const state = { vat_input: await holders('vat_input'), vat_output: await holders('vat_output'), bank: await holders('bank'), other_income: await holders('other_income') };
    show('R1', { out, state, violations: await violations() });
    // isActive null means "leave alone" on these routes: only the honest reactivation of the lone, clean claimant may succeed.
    expect(state.vat_input).toEqual([]); expect(state.vat_output).toEqual([]);
    expect(state.bank.length).toBeLessThanOrEqual(1);
    expect(await violations()).toEqual([]);
  }, 60_000);

  it('R2 a company whose data ALREADY breaks the rules is not locked out: it can save, edit, import, and repair itself', async () => {
    // header holder (AR has a child), mistyped holder (vat_input on a liability), two bank holders.
    await ins(id(), '1121', 'asset', null, false, { parent: AR, level: 4 });
    const VATL = id(); await ins(VATL, '2190', 'liability', 'vat_input', true);
    const BANK2 = id(); await ins(BANK2, '1111', 'asset', 'bank', true);
    const U = id(); await ins(U, '1300', 'asset', null, false); const S1 = id(); const S2 = id();
    await ins(S1, '6001', 'expense', 'operating_expense', false); await ins(S2, '6002', 'expense', 'operating_expense', false);
    const NEWAR = id(); await ins(NEWAR, '1125', 'asset', null, false); const NEWVAT = id(); await ins(NEWVAT, '1145', 'asset', null, false);
    const NEWAP = id(); await ins(NEWAP, '2115', 'liability', null, false);
    const dirty = await violations();
    const loaded = async () => ((await fx.call(defaultAccounts, 'GET', '/api/accounting/default-accounts', {})).body as { data?: { mappings?: Record<string, string> } }).data?.mappings ?? {};
    const saveKey = async (k: string, to: string) => { const l = await loaded(); return st(await fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', { mappings: { [k]: to }, loaded: { [k]: l[k] } })); };
    const steps: Record<string, unknown> = {};
    steps['edit an unrelated account (rename)'] = st(await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: U, accountName: 'Stock' }));
    steps['deactivate + reactivate an unrelated account'] = [
      st(await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: U, isActive: false })),
      st(await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: U, isActive: true }))];
    steps['reclassify an unrelated account'] = st(await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: U, accountSubtype: 'inventory' }));
    steps['create an account'] = st(await fx.call(coa, 'POST', '/api/accounting/chart-of-accounts', { accountCode: '1301', accountName: 'Stock B', accountType: 'asset', normalBalance: 'debit', parentAccountId: U }));
    steps['rename the header holder'] = st(await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: AR, accountName: 'Debtors control' }));
    steps['bank details on a contested bank holder'] = st(await fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: BANK2, bankName: 'ABSA' }));
    steps['save a DIFFERENT role (payable)'] = await saveKey('accounts_payable', NEWAP);
    steps['MCP merge two unrelated accounts'] = await mcp('merge_gl_accounts', { source_account_id: S1, target_account_id: S2 });
    steps['OBE auto-create'] = await (async () => { const tx = await fx.openTx(drainAfterCommit); const r = await tx.run(() => ensureOpeningBalanceEquityAccount(CO)).then(() => 'ok', (e: Error) => `THROWN ${e.message.slice(0, 140)}`); await tx.commit().catch(() => undefined); return r; })();
    steps['CoA import, new rows, empty map'] = await importCoa([{ accountCode: '7000', accountName: 'New', accountType: 'expense', normalBalance: 'debit', accountSubtype: 'operating_expense' }], {});
    steps['CoA import re-stating the existing holders in its map'] = await importCoa(
      [{ accountCode: '1120', accountName: 'Debtors control', accountType: 'asset', normalBalance: 'debit' }, { accountCode: '4100', accountName: 'Sales', accountType: 'revenue', normalBalance: 'credit' }],
      { receivable: '1120', default_revenue: '4100' });
    steps['coa-seed'] = st(await fx.call(coaSeed, 'POST', '/api/accounting/coa-seed', { template: 'isaflow_standard' }));
    // repair
    steps['REPAIR receivable -> clean account'] = await saveKey('accounts_receivable', NEWAR);
    steps['REPAIR vat_input -> clean asset'] = await saveKey('purchase_vat_input', NEWVAT);
    steps['REPAIR settle the contested bank on its winner'] = await (async () => { const l = await loaded(); return st(await fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', { mappings: { primary_bank: l.primary_bank }, loaded: { primary_bank: l.primary_bank } })); })();
    const after = await violations();
    show('R2', { dirtyBefore: dirty, steps, violationsAfterRepair: after, resolver: { bank: await resolve('bank'), receivable: await resolve('receivable'), vat_input: await resolve('vat_input') } });
    const refused = Object.entries(steps).filter(([k, v]) => !k.startsWith('CoA import re-stating') && JSON.stringify(v).match(/"?(4\d\d|5\d\d) |refused|THROWN/));
    expect(refused).toEqual([]);
    expect(after).toEqual([]);
  }, 60_000);

  it('R3 sub-accounts: allowed under income-statement holders (4100, 5100) by every path, refused under balance-sheet holders by every path', async () => {
    const out: Record<string, unknown> = {};
    const mover = async (code: string, type: string) => { const a = id(); await ins(a, code, type, type === 'revenue' ? 'revenue' : type === 'expense' ? 'operating_expense' : null, false); return a; };
    const paths = async (label: string, parent: string, parentCode: string, type: string, n: string) => {
      const sub = type === 'revenue' ? { accountSubtype: 'revenue' } : type === 'expense' ? { accountSubtype: 'operating_expense' } : {};
      const nb = ['asset', 'expense'].includes(type) ? 'debit' : 'credit';
      out[`${label} / route create`] = st(await fx.call(coa, 'POST', '/api/accounting/chart-of-accounts', { accountCode: `${n}1`, accountName: 'c', accountType: type, normalBalance: nb, parentAccountId: parent, ...sub }));
      out[`${label} / MCP create`] = await mcp('create_gl_account', { account_code: `${n}2`, account_name: 'c', account_type: type, parent_account_id: parent, ...(sub.accountSubtype ? { account_subtype: sub.accountSubtype } : {}) });
      out[`${label} / route reparent`] = st(await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: await mover(`${n}3`, type), parentAccountId: parent }));
      out[`${label} / MCP reparent`] = await mcp('update_gl_account', { account_id: await mover(`${n}4`, type), parent_account_id: parent });
      out[`${label} / import parentCode`] = await importCoa([{ accountCode: `${n}5`, accountName: 'c', accountType: type, normalBalance: nb, parentCode, ...sub }], {});
      const s = await mover(`${n}6`, type); await ins(id(), `${n}7`, type, sub.accountSubtype ?? null, false, { parent: s, level: 4 });
      out[`${label} / MCP merge (source has a child)`] = await mcp('merge_gl_accounts', { source_account_id: s, target_account_id: parent });
    };
    await paths('under 4100 revenue holder', REV, '4100', 'revenue', '41');
    await paths('under 5100 cost-of-sales holder', EXP, '5100', 'expense', '51');
    await paths('under bank holder', BANK, '1110', 'asset', '19');
    await paths('under receivable holder', AR, '1120', 'asset', '18');
    await paths('under payable holder', AP, '2110', 'liability', '29');
    const B2 = id(); await ins(B2, '1111', 'asset', 'bank', false);
    out['under bank holder / bank grouping'] = st(await fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: B2, parentAccountId: BANK }));
    // D5 (Hein, 2026-10-02): the same split decides ASSIGNMENT — an income-statement role may be moved onto a revenue header
    const RH = id(); await ins(RH, '4200', 'revenue', 'other', false); await ins(id(), '4201', 'revenue', 'revenue', false, { parent: RH, level: 4 });
    out['save: move default revenue ONTO a revenue header'] = st(await fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', { mappings: { sales_revenue: RH }, loaded: { sales_revenue: REV } }));
    // and a holder that has gained children can still be used and edited
    out['rename 4100 once it has children'] = st(await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: REV, accountName: 'Sales' }));
    out['save another role once 4100 has children'] = st(await fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', { mappings: { primary_bank: X }, loaded: { primary_bank: BANK } }));
    const kids = async (p: string) => (await fx.query('SELECT count(*)::int AS n FROM gl_accounts WHERE parent_account_id = $1', [p])).rows[0].n;
    const children = { '4100': await kids(REV), '5100': await kids(EXP), bank1110: await kids(BANK), ar1120: await kids(AR), ap2110: await kids(AP) };
    show('R3', { out, children, violations: await violations() });
    const allowedRefused = Object.entries(out).filter(([k, v]) => /^under (4100|5100)/.test(k) && v !== 200 && v !== 'ok' && !String(v).startsWith('200 imported 1'));
    const barredAllowed = Object.entries(out).filter(([k, v]) => /^under (bank|receivable|payable)/.test(k) && (v === 200 || v === 'ok' || String(v).startsWith('200 imported 1')));
    expect({ allowedRefused, barredAllowed }).toEqual({ allowedRefused: [], barredAllowed: [] });
    expect(children).toMatchObject({ bank1110: 0, ar1120: 0, ap2110: 0 });
    expect({ save: out['save: move default revenue ONTO a revenue header'], holder: await holders('default_revenue') }).toEqual({ save: 200, holder: ['4200'] });
  }, 90_000);

  it('R4 rows with NULL is_system_account / is_active through rollback, seed, import, reactivation and the post-condition', async () => {
    const N1 = id(); const N2 = id(); const N3 = id(); const N4 = id();
    await ins(N1, '1500', 'asset', null, false, { importedFrom: 'xero' });          // imported, flag NULL: rollback must delete it
    await ins(N2, '1140', 'asset', 'vat_input', true);                              // vat_input claimant whose flag is NULL: not a holder
    await ins(N3, '2120', 'liability', 'vat_output', true);                         // system vat_output whose is_active is NULL: not a holder
    await ins(N4, '1000', 'asset', null, true);                                     // header on a template parent code, flag NULL
    await fx.query('UPDATE gl_accounts SET is_system_account = NULL WHERE id = ANY($1::uuid[])', [[N1, N2, N4]]);
    await fx.query('UPDATE gl_accounts SET is_active = NULL WHERE id = $1', [N3]);
    const out: Record<string, unknown> = {};
    out.resolverBefore = { vat_input: await resolve('vat_input'), vat_output: await resolve('vat_output') };
    out.rollback = st(await fx.call(migrationRollback, 'POST', '/api/accounting/migration-rollback', { source: 'xero' }));
    out.importedRowGone = (await fx.query('SELECT count(*)::int AS n FROM gl_accounts WHERE id = $1', [N1])).rows[0].n === 0;
    out.reactivateNullActive = st(await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: N3, isActive: true }));
    out.importOverNullFlagRow = await importCoa([{ accountCode: '1140', accountName: 'VAT in', accountType: 'asset', normalBalance: 'debit' }], { vat_input: '1140' });
    out.editUnrelated = st(await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: X, isActive: false }));
    out.seed = st(await fx.call(coaSeed, 'POST', '/api/accounting/coa-seed', { template: 'isaflow_standard' }));
    const wired = (await fx.query(`SELECT count(*)::int AS n FROM gl_accounts c WHERE c.company_id = $1 AND c.parent_account_id = $2`, [CO, N4])).rows[0].n;
    const state = { vat_input: await holders('vat_input'), vat_output: await holders('vat_output'), bank: await holders('bank'), receivable: await holders('receivable'), childrenWiredUnderNullFlag1000: wired };
    show('R4', { out, state, violations: await violations(), resolverAfter: { vat_input: await resolve('vat_input'), vat_output: await resolve('vat_output') } });
    expect(out.importedRowGone).toBe(true);
    expect(state.vat_input).toHaveLength(1); expect(state.vat_output).toHaveLength(1);
    expect(state.bank).toEqual(['1110']); expect(state.receivable).toEqual(['1120']);
    expect(await violations()).toEqual([]);
  }, 60_000);
});
