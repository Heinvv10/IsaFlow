// Ported from the adversarial round's second pass on PR #593 at 031cd38ae (brk-593/pass2); each case asserts
// the claim, so it was RED where the breaker broke it. Changes from the breaker's file are marked "Ported note".
// brk-593 pass 2: attacks on what the delta added. Each test asserts the claim; a failure is a break.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { brkFixture, show, sleep, within } from './w2-28-brk593.helpers';
import { drainAfterCommit } from '@/lib/afterCommit';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { updateGlAccountTool, createGlAccountTool } from '../../src/lib/mcp/tools/writeGlAccounts';
import { mergeGlAccountsTool } from '../../src/lib/mcp/tools/writeMergeGlAccounts';
import coa from '../../pages/api/accounting/chart-of-accounts';
import bankAccounts from '../../pages/api/accounting/bank-accounts';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import coaSeed from '../../pages/api/accounting/coa-seed';
import coaImport from '../../pages/api/accounting/migration/chart-of-accounts';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { clearSystemAccountCache, getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { ensureOpeningBalanceEquityAccount } from '@/modules/accounting/services/gl/openingBalanceEquityService';
import { updateAccount } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { SYSTEM_ACCOUNT_KEYS } from '@/modules/accounting/services/gl/systemAccountKeys';

const fx = brkFixture('BRK593P2');
const { CO, USER, ins, holders } = fx;
const AR = '00000000-0000-4000-8000-' + randomUUID().slice(-12);
const BANK = '11111111-1111-4111-8111-' + randomUUID().slice(-12);
const X = 'ffffffff-ffff-4fff-bfff-' + randomUUID().slice(-12);
const RE = randomUUID();
const ctx = () => ({ userId: USER, companyId: CO, scopes: ['write:accounts', 'write:post', 'write:journals', 'read:accounts'], tokenJti: 'brk593', oauthAppId: null }) as never;
const registry = new McpRegistry();
for (const t of [updateGlAccountTool, createGlAccountTool, mergeGlAccountsTool]) registry.register(t);
const resolve = (key: string) => getSystemAccount(key as never, CO)
  .then((a) => ({ id: a.id, code: a.accountCode }), (e: Error) => ({ threw: e.constructor.name }));
const headerHolders = async () => (await fx.query(
  `SELECT h.account_code, h.account_subtype FROM gl_accounts h WHERE h.company_id = $1 AND h.is_system_account AND h.is_active
     AND h.account_subtype = ANY($2::text[]) AND EXISTS (SELECT 1 FROM gl_accounts c WHERE c.parent_account_id = h.id)`,
  [CO, [...SYSTEM_ACCOUNT_KEYS]])).rows.map((r) => `${r.account_code}:${r.account_subtype}`);
const notExactlyOne = async (keys: readonly string[]) => {
  const out: Record<string, string[]> = {};
  for (const k of keys) { const h = await holders(k); if (h.length !== 1) out[k] = h; }
  return out;
};
const untilWaiting = async (like: string, tries = 100) => {
  for (let i = 0; i < tries; i++) {
    if ((await fx.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE $1", [like])).rows[0].n > 0) return true;
    await sleep(50);
  }
  return false;
};

describe('brk-593 pass 2', () => {
  beforeAll(fx.setup);
  beforeEach(async () => {
    await fx.wipe(); clearSystemAccountCache(CO);
    await ins(AR, '1120', 'asset', 'receivable', true);
    await ins(BANK, '1110', 'asset', 'bank', true);
    await ins(X, '1115', 'asset', null, false);
  });
  afterAll(fx.teardown);

  it('P1 an MCP batch (one transaction) that renames a role holder and then changes is_active, racing a save, must not deadlock', async () => {
    const tx = await fx.openTx(drainAfterCommit);
    try {
      const first = await tx.run(() => registry.call('update_gl_account',
        { account_id: BANK, account_name: 'Main bank (renamed)', idempotency_key: randomUUID() }, ctx()));
      const saving = fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', { mappings: { primary_bank: X }, loaded: { primary_bank: BANK } });
      const saveWaits = await untilWaiting('%FOR NO KEY UPDATE%', 60);     // save holds the role lock, waits on the renamed row
      const second = await tx.run(() => registry.call('update_gl_account',
        { account_id: X, is_active: false, idempotency_key: randomUUID() }, ctx()).then((r) => r, (e: Error) => ({ thrown: e.message })));
      await tx.commit().catch(async (e: Error) => { show('P1 commit', e.message); });
      const s = await saving;
      show('P1', { firstIsError: (first as { isError?: boolean }).isError ?? false, saveWaitedOnRenamedRow: saveWaits,
        second: JSON.stringify(second).slice(0, 300), save: s.statusCode, saveBody: JSON.stringify(s.body).slice(0, 200), bank: await holders('bank') });
      expect(JSON.stringify(second) + JSON.stringify(s.body)).not.toMatch(/deadlock|GENERIC_FAILURE/i);
      expect(s.statusCode).toBeLessThan(500);
    } finally { await tx.rollback().catch(() => undefined); }
  }, 30_000);

  it('P2 Opening Balance Equity auto-create (set_opening_balance) must not give the retained-earnings holder a sub-account', async () => {
    await ins(RE, '3000', 'equity', 'retained_earnings', true, { level: 1 });
    const tx = await fx.openTx(drainAfterCommit);
    const created = await tx.run(() => ensureOpeningBalanceEquityAccount(CO)).then((r) => r, (e: Error) => ({ refused: e.message }));
    await tx.commit();
    const h = await headerHolders();
    show('P2', { created, headerHolders: h, rows: await fx.rows() });
    expect(h).toEqual([]);
  });

  it('P3 holder-as-parent from every other path is refused (route create, MCP create, route reparent, MCP reparent, bank grouping, CoA import parentCode, template seed, MCP merge moving children)', async () => {
    const G = randomUUID(); const S = randomUUID(); const C = randomUUID(); const B2 = randomUUID();
    await ins(G, '1130', 'asset', null, false);
    await ins(B2, '1111', 'asset', 'bank', false);
    await ins(S, '1150', 'asset', null, false);
    await ins(C, '1151', 'asset', null, false, { parent: S, level: 4 });
    const out: Record<string, unknown> = {};
    out.routeCreate = (await fx.call(coa, 'POST', '/api/accounting/chart-of-accounts', { accountCode: '1120A', accountName: 'c', accountType: 'asset', normalBalance: 'debit', parentAccountId: AR })).statusCode;
    let tx = await fx.openTx(drainAfterCommit);
    out.mcpCreate = (await tx.run(() => registry.call('create_gl_account', { account_code: '1120B', account_name: 'c', account_type: 'asset', parent_account_id: AR, idempotency_key: randomUUID() }, ctx()))).isError;
    await tx.commit();
    out.routeReparent = (await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: G, parentAccountId: AR })).statusCode;
    tx = await fx.openTx(drainAfterCommit);
    out.mcpReparent = (await tx.run(() => registry.call('update_gl_account', { account_id: G, parent_account_id: BANK, idempotency_key: randomUUID() }, ctx()))).isError;
    await tx.commit();
    out.bankGroup = (await fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: B2, parentAccountId: BANK })).statusCode;
    const session = await createSession(CO, 'sage', USER);
    out.importParent = (await fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id,
      accounts: [{ accountCode: '1121', accountName: 'debtors sub', accountType: 'asset', normalBalance: 'debit', parentCode: '1120' }], systemAccountMap: {} })).body;
    tx = await fx.openTx(drainAfterCommit);
    const merged = await tx.run(() => registry.call('merge_gl_accounts', { source_account_id: S, target_account_id: AR, idempotency_key: randomUUID() }, ctx())
      .then((r) => r, (e: Error) => ({ thrown: e.message })));
    await tx.commit().catch(() => undefined);
    out.mcpMerge = JSON.stringify(merged).slice(0, 260);
    const h = await headerHolders();
    show('P3', { out, headerHolders: h });
    expect(h).toEqual([]);
  }, 30_000);

  it('P4 the template seed must not hang a template row under the company\'s own holder (holder on the template parent code)', async () => {
    // isaflow_standard hangs 1110/1120/1140… under its 1100 "Current Assets": give the company's receivable holder that code.
    await fx.query('UPDATE gl_accounts SET account_code = $2 WHERE id = $1', [AR, '1100']);
    const r = await fx.call(coaSeed, 'POST', '/api/accounting/coa-seed', { template: 'isaflow_standard' });
    const h = await headerHolders();
    show('P4', { status: r.statusCode, headerHolders: h, rolesNotOne: await notExactlyOne(['bank', 'receivable', 'payable', 'vat_input', 'vat_output', 'retained_earnings']) });
    expect(h).toEqual([]);
  });

  it('P5 cache: A reactivates the empty bank role and resolves inside its tx, then ROLLS BACK; B resolves meanwhile; after both the resolver answers committed state', async () => {
    await fx.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [BANK]);
    const a = await fx.openTx(drainAfterCommit);
    const inA = await a.run(async () => { await updateAccount(CO, BANK, { isActive: true }); return resolve('bank'); });
    const b = await fx.openTx(drainAfterCommit);
    const inB = await b.run(() => resolve('bank'));
    await b.commit();
    await a.rollback();
    const after = await resolve('bank');
    show('P5', { inA, inB, committedHolders: await holders('bank'), after });
    expect({ inA, inB, after }).toEqual({ inA: { id: BANK, code: '1110' }, inB: { threw: 'MissingSystemAccountError' }, after: { threw: 'MissingSystemAccountError' } });
  });

  it('P6 cache: a resolve inside a transaction that changed no role is still cached and correct; after a committed move the next call sees the new holder', async () => {
    const t = await fx.openTx(drainAfterCommit);
    const inT = await t.run(() => resolve('bank'));
    await t.commit();
    const s = await fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', { mappings: { primary_bank: X }, loaded: { primary_bank: BANK } });
    const after = await resolve('bank');
    show('P6', { inT, save: s.statusCode, after });
    expect(after).toEqual({ id: X, code: '1115' });
  });

  it('P7 joint post-condition: a CoA import mapping bank to X and a save mapping bank to Y, concurrently, leave exactly one bank holder', async () => {
    const Y = randomUUID(); await ins(Y, '1116', 'asset', null, false);
    const session = await createSession(CO, 'sage', USER);
    const [imp, sav] = await Promise.all([
      fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id,
        accounts: [{ accountCode: '1115', accountName: 'x', accountType: 'asset', normalBalance: 'debit' }], systemAccountMap: { bank: '1115' } }),
      fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', { mappings: { primary_bank: Y }, loaded: { primary_bank: BANK } }),
    ]);
    const bank = await holders('bank');
    show('P7', { import: imp.statusCode, importErrors: JSON.stringify((imp.body as { data?: { errors?: unknown } }).data?.errors ?? null).slice(0, 200), save: sav.statusCode, bank });
    expect(bank).toHaveLength(1);
  });
});
