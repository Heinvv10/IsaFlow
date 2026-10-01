// Ported from the adversarial round on PR #593 at 2ce8f234d (brk-593, claim 4); each case asserts
// the claim, so it was RED where the breaker broke it. Changes from the breaker's file are marked "Ported note".
// brk-593 claim 4 (NO DEADLOCK, NO UNBOUNDED WAIT, NO COLLATERAL DAMAGE). A failing test is a break.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { brkFixture, show, sleep, within } from './w2-28-brk593.helpers';
import { drainAfterCommit } from '@/lib/afterCommit';
import coa from '../../pages/api/accounting/chart-of-accounts';
import coaDetail from '../../pages/api/accounting/chart-of-accounts-detail';
import bankAccounts from '../../pages/api/accounting/bank-accounts';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import coaSeed from '../../pages/api/accounting/coa-seed';
import coaImport from '../../pages/api/accounting/migration/chart-of-accounts';
import migrationExecute from '../../pages/api/accounting/migration-execute';
import migrationRollback from '../../pages/api/accounting/migration-rollback';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { createAccount } from '@/modules/accounting/services/gl/chartOfAccountsService';

const fx = brkFixture('BRK593C4');
const { CO, USER, ins, holders } = fx;
// ids chosen so the ascending-id order is AR < CHILD/MID < X < BANK
const AR = '00000000-0000-4000-8000-' + randomUUID().slice(-12);
const MID = '44444444-4444-4444-8444-' + randomUUID().slice(-12);
const X = '88888888-8888-4888-8888-' + randomUUID().slice(-12);
const BANK = 'ffffffff-ffff-4fff-bfff-' + randomUUID().slice(-12);
const save = (mappings: Record<string, unknown> = { primary_bank: X }, loaded: Record<string, unknown> = { primary_bank: BANK }) =>
  fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', { mappings, loaded });
const msg = (s: { body: Record<string, unknown> }) => JSON.stringify(s.body).slice(0, 300);

/** A plain second session holding something, to order the two requests under test. */
async function blocker(sqlText: string, values: unknown[]) {
  const c: PoolClient = await fx.connect();
  await c.query('BEGIN'); await c.query(sqlText, values);
  let open = true;
  return { release: async () => { if (!open) return; open = false; try { await c.query('ROLLBACK'); } finally { c.release(); } } };
}
const waitingOn = async (like: string) => (await fx.query(
  "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE $1", [like])).rows[0].n as number;
const untilWaiting = async (like: string, tries = 100) => { for (let i = 0; i < tries; i++) { if (await waitingOn(like) > 0) return true; await sleep(50); } return false; };

describe('brk-593 claim 4: locks', () => {
  beforeAll(fx.setup);
  beforeEach(async () => {
    await fx.wipe(); clearSystemAccountCache(CO);
    await ins(AR, '1120', 'asset', 'receivable', true);
    await ins(BANK, '1110', 'asset', 'bank', true);
    await ins(X, '1115', 'asset', null, false);
  });
  afterAll(fx.teardown);

  it('4a account update (parent + isActive in one PUT) racing a save must not deadlock (40P01)', async () => {
    // The receivable holder has one child; a third session holds that child so the PUT pauses
    // after its reclassify UPDATE (row lock on the holder) and before updateAccount's role-write lock.
    await ins(MID, '1121', 'asset', null, false, { parent: AR, level: 4 });
    const b = await blocker('SELECT 1 FROM gl_accounts WHERE id = $1 FOR UPDATE', [MID]);
    try {
      const put = fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: AR, parentAccountId: null, isActive: true });
      expect(await untilWaiting('%UPDATE gl_accounts SET level = level +%')).toBe(true);   // PUT holds the AR row
      const saving = save();                                                                // takes the role lock, waits on the AR row
      const saveWaits = await untilWaiting('%FOR NO KEY UPDATE%', 30);                      // (master's save takes no such lock)
      await b.release();                                                                    // PUT goes on to ask for the role lock
      const [p, s] = await Promise.all([put, saving]);
      show('4a', { saveWaitedOnRoleRows: saveWaits, put: p.statusCode, putBody: msg(p), save: s.statusCode, saveBody: msg(s) });
      expect(msg(p) + msg(s)).not.toMatch(/deadlock/i);
      expect([p.statusCode, s.statusCode].every((c) => c < 500)).toBe(true);
    } finally { await b.release(); }
  }, 30_000);

  it('4b migration execute (re-import touching role rows) racing a save must not deadlock (40P01)', async () => {
    await ins(MID, '1130', 'asset', null, false, { importedFrom: 'xero' });
    const acct = (code: string) => ({ sourceCode: code, sourceName: `acct ${code}`, sourceType: 'asset', mappedType: 'asset', mappedNormalBalance: 'debit' });
    const b = await blocker('SELECT 1 FROM gl_accounts WHERE id = $1 FOR UPDATE', [MID]);
    try {
      // upsert order: BANK (last by id), MID (held), AR (first by id)
      const exec = fx.call(migrationExecute, 'POST', '/api/accounting/migration-execute',
        { source: 'xero', accounts: [acct('1110'), acct('1130'), acct('1120')], customers: [], suppliers: [] });
      expect(await untilWaiting('%INSERT INTO gl_accounts%')).toBe(true);                  // execute holds the BANK row, waits on MID
      const saving = save();                                                                // role lock, AR row, then waits on BANK
      const saveWaits = await untilWaiting('%FOR NO KEY UPDATE%', 30);
      await b.release();                                                                    // execute goes on to the AR row
      const [e, s] = await Promise.all([exec, saving]);
      show('4b', { saveWaitedOnRoleRows: saveWaits, execute: e.statusCode, executeBody: msg(e), save: s.statusCode, saveBody: msg(s) });
      expect(msg(e)).not.toMatch(/deadlock/i);
      expect([e.statusCode, s.statusCode]).toEqual([200, 200]);   // a 500 here is the 40P01: see the 'deadlock detected' log lines in the saved output
    } finally { await b.release(); }
  }, 30_000);

  it('4c a save must not wait unbounded on a role row another request holds (and must not hold the role lock while it does)', async () => {
    // Any request that has updated a role row and not yet committed: bank-accounts PUT without isActive,
    // a code rename, migration execute — none take the role-write lock.
    const b = await blocker('UPDATE gl_accounts SET description = $2 WHERE id = $1', [BANK, 'slow request']);
    try {
      const t0 = Date.now();
      const saving = save();
      const at8s = await within(8000, saving);
      // meanwhile every other role writer of the company waits on the role lock the save is holding
      const del = await fx.call(coaDetail, 'DELETE', '/api/accounting/chart-of-accounts-detail', { id: X });
      const delMs = Date.now() - t0;
      const at15s = await within(2000, saving);
      await b.release();
      const s = await saving;
      show('4c', { saveAfter8s: typeof at8s === 'string' ? at8s : at8s.statusCode, saveAfter15s: typeof at15s === 'string' ? at15s : at15s.statusCode,
        otherWriterStatus: del.statusCode, otherWriterBody: msg(del), otherWriterAnsweredAtMs: delMs, saveFinally: s.statusCode, totalMs: Date.now() - t0 });
      expect(typeof at8s === 'string' ? at8s : `answered ${at8s.statusCode}`).toMatch(/^answered/);
    } finally { await b.release(); }
  }, 60_000);

  it('4d a 5s lock_timeout must not leak onto later statements of the same request', async () => {
    const PARENT = randomUUID();
    await ins(PARENT, '1000', 'asset', null, false, { level: 1 });
    const tx = await fx.openTx(drainAfterCommit);
    try {
      const before = (await tx.client.query('SHOW lock_timeout')).rows[0].lock_timeout;
      await tx.run(() => createAccount(CO, { accountCode: '1001', accountName: 'child', accountType: 'asset', normalBalance: 'debit', parentAccountId: PARENT } as never));
      const after = (await tx.client.query('SHOW lock_timeout')).rows[0].lock_timeout;
      show('4d', { before, afterCreateAccountUnderLevel1Parent: after });
      expect(after).toBe(before);
    } finally { await tx.rollback(); }
  });

  it('4e a role-write lock timeout answers 503 on every changed route', async () => {
    const PARENT = randomUUID(); const OLD = randomUUID();
    await ins(PARENT, '1000', 'asset', null, false, { level: 1 });
    await ins(OLD, '1105', 'asset', 'bank', false, { active: false });
    const session = await createSession(CO, 'sage', USER);
    const b = await blocker('SELECT pg_advisory_xact_lock(hashtextextended($1::TEXT, 0))', [`default-accounts:${CO}`]);
    try {
      const h0 = await fx.hash();
      const calls: Record<string, Promise<{ statusCode: number; body: Record<string, unknown> }>> = {
        save: save(),
        deleteAccount: fx.call(coaDetail, 'DELETE', '/api/accounting/chart-of-accounts-detail', { id: X }),
        detailPutIsActive: fx.call(coaDetail, 'PUT', '/api/accounting/chart-of-accounts-detail', { id: X, isActive: false }),
        coaPutIsActive: fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: X, isActive: false }),
        coaPutSubtype: fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: X, accountSubtype: 'inventory' }),
        coaPutParentThenIsActive: fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: X, parentAccountId: null, isActive: false }),
        coaPostChildOfLevel1: fx.call(coa, 'POST', '/api/accounting/chart-of-accounts', { accountCode: '1001', accountName: 'child', accountType: 'asset', normalBalance: 'debit', parentAccountId: PARENT }),
        bankPutIsActive: fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: OLD, isActive: true }),
        coaSeed: fx.call(coaSeed, 'POST', '/api/accounting/coa-seed', { template: 'isaflow_standard' }),
        coaImport: fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id,
          accounts: [{ accountCode: '1115', accountName: 'x', accountType: 'asset', normalBalance: 'debit' }], systemAccountMap: { bank: '1115' } }),
        migrationRollback: fx.call(migrationRollback, 'POST', '/api/accounting/migration-rollback', { source: 'xero' }),
      };
      const out: Record<string, number> = {};
      for (const [k, p] of Object.entries(calls)) out[k] = (await p).statusCode;
      await b.release();
      const h1 = await fx.hash();
      show('4e', { statuses: out, nothingWritten: h0 === h1 });
      expect(h1).toBe(h0);
      expect(out).toEqual(Object.fromEntries(Object.keys(calls).map((k) => [k, 503])));
    } finally { await b.release(); }
  }, 60_000);
});
