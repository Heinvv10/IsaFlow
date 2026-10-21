// Ported from the adversarial round's third pass on PR #593 at 38978241e (brk-593/pass3); each case asserts
// the claim, so it was RED where the breaker broke it. Changes from the breaker's file are marked "Ported note".
// brk-593 pass 3: attacks on what the delta added. Each test asserts the claim; a failure is a break.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { brkFixture, show, sleep, within } from './w2-28-brk593.helpers';
import { drainAfterCommit } from '@/lib/afterCommit';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { updateGlAccountTool, createGlAccountTool } from '../../src/lib/mcp/tools/writeGlAccounts';
import { mergeGlAccountsTool } from '../../src/lib/mcp/tools/writeMergeGlAccounts';
import { setOpeningBalanceTool } from '../../src/lib/mcp/tools/writeOpeningBalance';
import coa from '../../pages/api/accounting/chart-of-accounts';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import coaImport from '../../pages/api/accounting/migration/chart-of-accounts';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { documentLineAccountRefusal } from '@/modules/accounting/services/gl/documentLineAccountGuard';

const fx = brkFixture('BRK593P3');
const { CO, USER, ins, holders } = fx;
const AR = '00000000-0000-4000-8000-' + randomUUID().slice(-12);
const BANK = '11111111-1111-4111-8111-' + randomUUID().slice(-12);
const X = 'ffffffff-ffff-4fff-bfff-' + randomUUID().slice(-12);
const Y = randomUUID(); const Z = randomUUID();
const ctx = () => ({ userId: USER, companyId: CO, scopes: ['write:accounts', 'write:post', 'write:journals', 'read:accounts'], companyRole: 'owner', tokenJti: 'brk593', oauthAppId: null }) as never;
const registry = new McpRegistry();
for (const t of [updateGlAccountTool, createGlAccountTool, mergeGlAccountsTool, setOpeningBalanceTool]) registry.register(t);
const call = (name: string, args: Record<string, unknown>) => registry.call(name, { ...args, idempotency_key: randomUUID() }, ctx())
  .then((r) => ({ isError: r.isError === true, text: JSON.stringify(r.content).slice(0, 220) }), (e: Error & { code?: string }) => ({ thrown: `${e.code ?? ''} ${e.message}`.slice(0, 220) }));
const save = (to = X) => fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', { mappings: { primary_bank: to }, loaded: { primary_bank: BANK } });
const untilWaiting = async (like: string, tries = 100) => {
  for (let i = 0; i < tries; i++) {
    if ((await fx.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE $1", [like])).rows[0].n > 0) return true;
    await sleep(50);
  }
  return false;
};
const deadlocks = async () => { await sleep(700); return (await fx.query('SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()')).rows[0].n as number; };
async function blocker(sqlText: string, values: unknown[]) {
  const c: PoolClient = await fx.connect();
  await c.query('BEGIN'); await c.query(sqlText, values);
  let open = true;
  return { release: async () => { if (!open) return; open = false; try { await c.query('ROLLBACK'); } finally { c.release(); } } };
}

describe('brk-593 pass 3', () => {
  beforeAll(fx.setup);
  beforeEach(async () => {
    await fx.wipe(); await fx.query('DELETE FROM fiscal_periods WHERE company_id = $1', [CO]); clearSystemAccountCache(CO);
    await fx.query(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES ($1, 'FY26 brk', 1, 2026, '2026-01-01', '2026-12-31', 'open')`, [CO]);
    await ins(AR, '1120', 'asset', 'receivable', true);
    await ins(BANK, '1110', 'asset', 'bank', true);
    await ins(X, '1115', 'asset', null, false);
    await ins(Y, '1116', 'asset', null, false);
    await ins(Z, '1117', 'asset', null, false);
  });
  afterAll(async () => { await fx.wipe(); await fx.query('DELETE FROM fiscal_periods WHERE company_id = $1', [CO]); await fx.teardown(); });

  /** One MCP batch (one transaction): `first`, then — once a concurrent save is waiting — a role write. */
  async function batchThenSave(label: string, first: () => Promise<unknown>) {
    const d0 = await deadlocks();
    const tx = await fx.openTx(drainAfterCommit);
    try {
      const firstOut = await tx.run(first);
      const t0 = Date.now();
      const saving = save();
      const saveWaitsOnRow = await untilWaiting('%FOR NO KEY UPDATE%', 40);
      const second = await tx.run(() => call('update_gl_account', { account_id: Y, is_active: false }));
      const committed = await tx.commit().then(() => 'committed', (e: Error) => `commit failed: ${e.message}`);
      const s = await saving;
      const out = { first: JSON.stringify(firstOut).slice(0, 160), saveWaitsOnRow, second, committed, save: s.statusCode, saveMs: Date.now() - t0,
        deadlocksDetected: (await deadlocks()) - d0, bank: await holders('bank') };
      show(label, out);
      return out;
    } finally { await tx.rollback().catch(() => undefined); }
  }

  it('N1 batch: set_opening_balance (explicit contra) on the bank holder, then an is_active change, racing a save: no deadlock', async () => {
    const out = await batchThenSave('N1', () => call('set_opening_balance', { bank_account_id: BANK, as_at: '2026-06-10', amount: 100, contra_account_id: Z }));
    expect(out.deadlocksDetected).toBe(0);
  }, 30_000);

  it('N2 batch: a document-line guard (FOR SHARE) on the bank holder, then an is_active change, racing a save: the cycle is broken and exactly one side is told to retry', async () => {
    const out = await batchThenSave('N2', () => documentLineAccountRefusal(CO, [BANK]));
    // Ported note: the breaker's title and assertion were "no deadlock" (`deadlocksDetected === 0`). Decided
    // 2026-10-01: the line guards keep their FOR SHARE without the role lock, so this cycle DOES form. What
    // must hold: one side loses (the save: 503; or the tool: the retry refusal), the other goes through, and
    // nobody gets a 500 or the generic failure. Round 12 tightened this from "any of 200/400/409/503".
    const tool = JSON.stringify(out.second);
    const saveLost = out.save === 503; const toolLost = /"isError":true/.test(tool) && /retry in a moment/.test(tool);
    expect({ save: out.save, saveLost, toolLost, bank: out.bank }).toEqual(saveLost
      ? { save: 503, saveLost: true, toolLost: false, bank: ['1110'] }
      : { save: 200, saveLost: false, toolLost: true, bank: ['1115'] });
    expect(tool).not.toMatch(/operation failed|deadlock/i);
  }, 30_000);

  it('N3 two batches in reverse order (A: role write then rename of the bank holder; B: FOR SHARE on the bank holder then a role write): both are told to retry, nothing of either is written', async () => {
    const d0 = await deadlocks();
    const a = await fx.openTx(drainAfterCommit); const b = await fx.openTx(drainAfterCommit);
    try {
      const a1 = await a.run(() => call('update_gl_account', { account_id: Y, account_name: 'A holds the role lock' }));
      await b.run(() => documentLineAccountRefusal(CO, [BANK]));
      const a2 = a.run(() => call('update_gl_account', { account_id: BANK, account_name: 'renamed by A' }));
      const aWaits = await untilWaiting('%UPDATE gl_accounts SET%', 40);
      const b2 = await within(8000, b.run(() => call('update_gl_account', { account_id: Z, is_active: false })));
      await b.commit().catch(() => undefined);
      const a2out = await within(8000, a2);
      await a.commit().catch(() => undefined);
      const out = { a1, aWaitsOnRow: aWaits, a2: a2out, b2, deadlocksDetected: (await deadlocks()) - d0 };
      show('N3', out);
      // Ported note: as N2 — the breaker's "no deadlock" cannot hold. A waits for the row B holds; B waits for
      // the role lock A holds until A's batch ends. Postgres ends A's wait (deadlock victim) and B's wait is
      // bounded at 5s, so BOTH second calls are refused with the retry wording (round 12: tightened from
      // "whoever fails"), and neither rename nor deactivation is written.
      for (const answer of [out.a2, out.b2]) {
        const text = JSON.stringify(answer);
        expect(text).toMatch(/"isError":true.*retry in a moment/);
        expect(text).not.toMatch(/operation failed|deadlock|STILL WAITING/i);
      }
      const rows = (await fx.query('SELECT account_code, account_name, is_active FROM gl_accounts WHERE id = ANY($1::uuid[]) ORDER BY 1', [[BANK, Z]])).rows;
      expect(rows.map((r) => `${r.account_code}:${r.account_name}:${r.is_active}`)).toEqual(['1110:BRK593P3 1110:true', '1117:BRK593P3 1117:true']);
      expect(await holders('bank')).toEqual(['1110']);
    } finally { await a.rollback().catch(() => undefined); await b.rollback().catch(() => undefined); }
  }, 40_000);

  it('N4 an account edit must not wait unbounded on a row another request holds while holding the company role lock', async () => {
    // A slow request that coded a bill / PO / expense-claim line to X holds FOR SHARE on X until it ends.
    const bl = await blocker('SELECT 1 FROM gl_accounts WHERE id = $1 FOR SHARE', [X]);
    try {
      const t0 = Date.now();
      const put = fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: X, accountName: 'renamed' });
      await sleep(500);
      const s = await save(Y);                       // any other role writer of the company
      const saveMs = Date.now() - t0;
      const at8 = await within(8000 - Math.min(saveMs, 7000), put);
      await bl.release();
      const p = await put;
      show('N4', { putAfter8s: typeof at8 === 'string' ? at8 : at8.statusCode, otherWriter: s.statusCode, otherWriterBody: JSON.stringify(s.body).slice(0, 160), otherWriterMs: saveMs, putFinally: p.statusCode });
      expect(s.statusCode).toBe(200);
    } finally { await bl.release(); }
  }, 40_000);

  it('N5 create_gl_account and merge_gl_accounts under a held role lock: a retryable refusal, and the batch transaction stays usable', async () => {
    const PARENT = randomUUID(); const S = randomUUID();
    await ins(PARENT, '1000', 'asset', null, false, { level: 1 }); await ins(S, '1150', 'asset', null, false);
    const bl = await blocker('SELECT pg_advisory_xact_lock(hashtextextended($1::TEXT, 0))', [`default-accounts:${CO}`]);
    const tx = await fx.openTx(drainAfterCommit);
    try {
      const create = await tx.run(() => call('create_gl_account', { account_code: '1001', account_name: 'child', account_type: 'asset', parent_account_id: PARENT }));
      const merge = await tx.run(() => call('merge_gl_accounts', { source_account_id: S, target_account_id: Z }));
      await bl.release();
      const usable = await tx.run(() => call('update_gl_account', { account_id: Y, account_name: 'after the timeouts' }));
      const committed = await tx.commit().then(() => 'committed', (e: Error) => `commit failed: ${e.message}`);
      const name = (await fx.query('SELECT account_name FROM gl_accounts WHERE id = $1', [Y])).rows[0].account_name;
      show('N5', { create, merge, usable, committed, renamedAfter: name });
      expect(JSON.stringify(create)).toMatch(/retry/i); expect(JSON.stringify(merge)).toMatch(/retry/i);
      expect(name).toBe('after the timeouts');
    } finally { await bl.release(); await tx.rollback().catch(() => undefined); }
  }, 40_000);

  it('N6 the save\'s VAT-lock wait is bounded: 503 at ~5s, nothing written', async () => {
    const bl = await blocker('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 570))', [CO]);
    try {
      const h0 = await fx.hash(); const t0 = Date.now();
      const s = await within(9000, save());
      show('N6', { save: typeof s === 'string' ? s : s.statusCode, ms: Date.now() - t0, wrote: (await fx.hash()) !== h0 });
      expect(typeof s === 'string' ? s : s.statusCode).toBe(503);
    } finally { await bl.release(); }
  }, 30_000);

  const importCoa = async (accounts: unknown[], systemAccountMap: Record<string, unknown>) => {
    const session = await createSession(CO, 'sage', USER);
    return fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id, accounts, systemAccountMap });
  };
  const typeOfHolder = async (role: string) => (await fx.query(
    'SELECT account_code, account_type FROM gl_accounts WHERE company_id = $1 AND account_subtype = $2 AND is_system_account AND is_active', [CO, role])).rows;

  it('N7 CoA import role map: effective type, numeric / array / object field shapes — the bank role never lands on a non-asset, a header or two accounts', async () => {
    const SYS = randomUUID(); await ins(SYS, '2500', 'liability', null, true);          // a system account with no role, a liability
    const out: Record<string, unknown> = {};
    const run = async (label: string, accounts: unknown[], map: Record<string, unknown>) => {
      const r = await importCoa(accounts, map);
      out[label] = { status: r.statusCode, imported: (r.body as { data?: { imported?: number } }).data?.imported,
        err: JSON.stringify((r.body as { data?: { errors?: unknown } ; error?: unknown }).data?.errors ?? (r.body as { error?: unknown }).error ?? null).slice(0, 170),
        bank: await typeOfHolder('bank') };
    };
    await run('row says asset, existing system liability keeps its type', [{ accountCode: '2500', accountName: 'x', accountType: 'asset', normalBalance: 'debit' }], { bank: '2500' });
    await run('parentCode as a NUMBER naming the mapped row', [
      { accountCode: '1500', accountName: 'new bank', accountType: 'asset', normalBalance: 'debit' },
      { accountCode: '1501', accountName: 'child', accountType: 'asset', normalBalance: 'debit', parentCode: 1500 }], { bank: '1500' });
    await run('accountCode as a NUMBER on the mapped row', [{ accountCode: 1600, accountName: 'new bank', accountType: 'asset', normalBalance: 'debit' }], { bank: '1600' });
    await run('map value as a NUMBER', [{ accountCode: '1700', accountName: 'new bank', accountType: 'asset', normalBalance: 'debit' }], { bank: 1700 });
    await run('map value as an ARRAY', [{ accountCode: '1700', accountName: 'new bank', accountType: 'asset', normalBalance: 'debit' }], { bank: ['1700'] });
    await run('accountType as an ARRAY', [{ accountCode: '1800', accountName: 'new bank', accountType: ['asset'], normalBalance: 'debit' }], { bank: '1800' });
    await run('map key in another case + a duplicate role via __proto__', [{ accountCode: '1900', accountName: 'new bank', accountType: 'asset', normalBalance: 'debit' }],
      JSON.parse('{"Bank":"1900","__proto__":{"bank":"1900"}}'));
    await run('mapped row padded code', [{ accountCode: ' 1950 ', accountName: 'new bank', accountType: 'asset', normalBalance: 'debit' }], { bank: ' 1950 ' });
    const headers = (await fx.query(`SELECT h.account_code FROM gl_accounts h WHERE h.company_id = $1 AND h.is_system_account AND h.account_subtype = 'bank'
      AND EXISTS (SELECT 1 FROM gl_accounts c WHERE c.parent_account_id = h.id)`, [CO])).rows;
    const bank = await typeOfHolder('bank');
    show('N7', { out, finalBank: bank, bankHeaders: headers });
    expect(bank).toHaveLength(1); expect(bank[0].account_type).toBe('asset'); expect(headers).toEqual([]);
  }, 60_000);

  it('N8 import cap: 1,000 accounts import; a legitimate 1,001-account chart is still importable', async () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ accountCode: `Q${String(i).padStart(5, '0')}`, accountName: `acct ${i}`, accountType: 'asset', normalBalance: 'debit' }));
    const big = await importCoa(mk(1001), {});
    const t0 = Date.now();
    const ok = await importCoa(mk(1000), {});
    show('N8', { accounts1001: big.statusCode, body1001: JSON.stringify(big.body).slice(0, 200), accounts1000: ok.statusCode, imported: (ok.body as { data?: { imported?: number } }).data?.imported, ms1000: Date.now() - t0 });
    expect(ok.statusCode).toBe(200);
    expect(big.statusCode).toBe(200);
  }, 120_000);
});
