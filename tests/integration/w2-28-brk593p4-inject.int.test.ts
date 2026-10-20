// Ported from the adversarial round's fourth pass on PR #593 at 9366d761c (brk-593/pass4); it asserts the claim, so it
// was RED where the breaker broke it (create_gl_account and deactivate_gl_account). Only the helpers import path changed.
// brk-593 pass 4: a driver-style failure (an Error with no SQLSTATE code — node-postgres raises these for a dropped
// connection or a read timeout) AFTER the write statement has run. It must roll back: 500 on a route, never a committing 4xx;
// on a tool, never a returned tool error that leaves the write in place.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';

let inject = false;
vi.mock('@/modules/accounting/services/gl/systemRoleWriteLock', async (orig) => {
  const actual = await orig<typeof import('../../src/modules/accounting/services/gl/systemRoleWriteLock')>();
  const failing = async <T,>(take: () => PromiseLike<T>): Promise<T> => {
    const out = await actual.boundedRowWait(take);
    if (inject) { inject = false; throw new Error('Connection terminated unexpectedly'); }
    return out;
  };
  return { ...actual, boundedRowWait: failing };
});
import { brkFixture, show } from './w2-28-brk593.helpers';
import { drainAfterCommit } from '@/lib/afterCommit';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { updateGlAccountTool, createGlAccountTool, deactivateGlAccountTool } from '../../src/lib/mcp/tools/writeGlAccounts';
import coa from '../../pages/api/accounting/chart-of-accounts';
import coaDetail from '../../pages/api/accounting/chart-of-accounts-detail';
import bankAccounts from '../../pages/api/accounting/bank-accounts';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

const fx = brkFixture('BRK593P4I');
const { CO, USER, ins } = fx;
const BANK = randomUUID(); const X = randomUUID(); const B2 = randomUUID();
const ctx = () => ({ userId: USER, companyId: CO, scopes: ['write:accounts', 'write:post'], companyRole: 'owner', tokenJti: 'brk593', oauthAppId: null }) as never;
const registry = new McpRegistry();
for (const t of [updateGlAccountTool, createGlAccountTool, deactivateGlAccountTool]) registry.register(t);

describe('brk-593 pass 4: a code-less driver error after the write', () => {
  beforeAll(fx.setup);
  beforeEach(async () => {
    inject = false; await fx.wipe(); clearSystemAccountCache(CO);
    await ins(BANK, '1110', 'asset', 'bank', true); await ins(X, '1115', 'asset', null, false); await ins(B2, '1111', 'asset', 'bank', false);
  });
  afterAll(fx.teardown);

  it('routes answer 500 and roll back; tools do not leave the write behind', async () => {
    const table: Record<string, unknown> = {}; const bad: string[] = [];
    const routes: [string, unknown, string, string, Record<string, unknown>][] = [
      ['PUT chart rename', coa, 'PUT', '/api/accounting/chart-of-accounts', { id: X, accountName: 'renamed' }],
      ['PUT chart deactivate', coa, 'PUT', '/api/accounting/chart-of-accounts', { id: X, isActive: false }],
      ['POST chart create', coa, 'POST', '/api/accounting/chart-of-accounts', { accountCode: '1199', accountName: 'new', accountType: 'asset', normalBalance: 'debit' }],
      ['PUT detail rename', coaDetail, 'PUT', '/api/accounting/chart-of-accounts-detail', { id: X, accountName: 'renamed' }],
      ['PATCH detail code', coaDetail, 'PATCH', '/api/accounting/chart-of-accounts-detail', { id: X, accountCode: '1199' }],
      ['DELETE detail', coaDetail, 'DELETE', '/api/accounting/chart-of-accounts-detail', { id: X }],
      ['PUT bank fields', bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: B2, bankName: 'FNB' }],
    ];
    for (const [name, handler, method, url, body] of routes) {
      const h0 = await fx.hash(); inject = true;
      const r = await fx.call(handler, method, url, body);
      const fired = !inject; inject = false;
      const wrote = (await fx.hash()) !== h0;
      table[name] = { injected: fired, status: r.statusCode, body: JSON.stringify(r.body).slice(0, 140), wrote };
      if (!fired) bad.push(`${name}: injection point not reached`);
      else if (r.statusCode < 500 || wrote) bad.push(`${name}: ${r.statusCode}, wrote=${wrote}`);
    }
    const tools: [string, string, Record<string, unknown>][] = [
      ['MCP update_gl_account rename', 'update_gl_account', { account_id: X, account_name: 'renamed by tool' }],
      ['MCP create_gl_account', 'create_gl_account', { account_code: '1198', account_name: 'new', account_type: 'asset' }],
      ['MCP deactivate_gl_account', 'deactivate_gl_account', { account_id: X }],
    ];
    for (const [name, toolName, args] of tools) {
      const h0 = await fx.hash(); inject = true;
      const tx = await fx.openTx(drainAfterCommit);
      const r = await tx.run(() => registry.call(toolName, { ...args, idempotency_key: randomUUID() }, ctx()))
        .then((x) => `${x.isError ? 'isError' : 'ok'} ${JSON.stringify(x.content).slice(0, 130)}`, (e: Error) => `THROWN ${e.message.slice(0, 120)}`);
      const fired = !inject; inject = false;
      const committed = await tx.commit().then(() => 'committed', (e: Error) => `commit failed ${e.message}`);
      const wrote = (await fx.hash()) !== h0;
      table[name] = { injected: fired, result: r, committed, wrote };
      if (!fired) bad.push(`${name}: injection point not reached`);
      else if (wrote) bad.push(`${name}: the tool reported a failure and its write was committed`);
    }
    show('P4 inject', table);
    expect(bad).toEqual([]);
  }, 60_000);
});
