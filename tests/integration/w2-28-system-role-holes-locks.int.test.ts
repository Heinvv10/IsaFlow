// W2-28 round 5: a save must not deadlock with, or hold up, a journal posting
// on the role accounts, and a reactivation must not give a role a second
// holder. Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { makeGate, roleWriterFixture, sleep, type Gate } from './w2-28-role-writers.helpers';

let gate: Gate | null = null;
vi.mock('@/modules/accounting/services/gl/systemRoleCoverage', async (orig) => {
  const actual = await orig<typeof import('../../src/modules/accounting/services/gl/systemRoleCoverage')>();
  return {
    ...actual,
    getSystemRoleCoverage: async (...args: Parameters<typeof actual.getSystemRoleCoverage>) => {
      const out = await actual.getSystemRoleCoverage(...args);
      if (gate) { const g = gate; gate = null; g.reached(); await g.release; }
      return out;
    },
  };
});
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import bankAccounts from '../../pages/api/accounting/bank-accounts';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { updateAccount } from '../../src/modules/accounting/services/gl/chartOfAccountsService';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const fx = roleWriterFixture('W228R5L');
const { CO, USER, ins, holders } = fx;
const AR = '00000000-0000-4000-8000-' + randomUUID().slice(-12);     // receivable holder: first by id
const BANK = 'ffffffff-ffff-4fff-bfff-' + randomUUID().slice(-12);   // bank holder: last by id
const X = '88888888-8888-4888-8888-' + randomUUID().slice(-12);
const save = () => fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts',
  { mappings: { primary_bank: X }, loaded: { primary_bank: BANK } });
const within = <T>(ms: number, p: Promise<T>) => Promise.race([p, sleep(ms).then(() => `still waiting after ${ms}ms` as const)]);

describeIfDb('W2-28 a save against postings and reactivations', () => {
  beforeAll(fx.setup);
  beforeEach(async () => {
    gate = null; await fx.wipe(); clearSystemAccountCache(CO);
    await ins(AR, '1120', 'asset', 'receivable', true);
    await ins(BANK, '1110', 'asset', 'bank', true);
    await ins(X, '1115', 'asset', null, false);
  });
  afterAll(fx.teardown);

  /** A posting request: one draft journal whose lines are inserted one at a time. */
  async function posting() {
    const c: PoolClient = await fx.connect();
    await c.query('BEGIN');
    const je = (await c.query(
      'INSERT INTO gl_journal_entries (company_id, entry_date, created_by) VALUES ($1, CURRENT_DATE, $2) RETURNING id', [CO, USER])).rows[0].id;
    return {
      line: (account: string, debit: number, credit: number) => c.query(
        'INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,$4,$5)',
        [CO, je, account, debit, credit]).then(() => 'inserted', (e: { code?: string }) => `failed ${e.code}`),
      end: async () => { try { await c.query('ROLLBACK'); } finally { c.release(); } },
    };
  }

  it('a posting that has written its bank line, then a save, then the posting\'s receivable line: neither is killed (no 40P01)', async () => {
    const p = await posting();
    try {
      const first = await p.line(BANK, 0, 100);       // FK key-share on the bank holder (last by id)
      const saving = save();                          // locks role rows in id order: receivable first, then bank
      await sleep(300);
      const second = await within(4000, p.line(AR, 100, 0));
      await p.end();
      expect({ first, second, save: (await saving).statusCode }).toEqual({ first: 'inserted', second: 'inserted', save: 200 });
    } finally { await p.end().catch(() => undefined); }
  }, 20_000);

  it('a posting on the role accounts does not wait for a save in flight', async () => {
    const g = makeGate(); gate = g.gate;
    const saving = save();
    await g.reached;                                  // the save holds its row locks
    const p = await posting();
    try {
      const lines = await within(2000, Promise.all([p.line(BANK, 0, 100), p.line(AR, 100, 0)]));
      g.release();
      expect({ lines, save: (await saving).statusCode }).toEqual({ lines: ['inserted', 'inserted'], save: 200 });
    } finally { g.release(); await p.end(); }
  }, 20_000);

  it('a save in flight still blocks another writer of a role row\'s flags', async () => {
    const g = makeGate(); gate = g.gate;
    const saving = save();
    await g.reached;
    const c = await fx.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout = '1s'");
      const blocked = await c.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [BANK])
        .then(() => 'updated', (e: { code?: string }) => e.code);
      expect(blocked).toBe('55P03');
    } finally { await c.query('ROLLBACK'); c.release(); g.release(); }
    expect((await saving).statusCode).toBe(200);
  });

  it('reactivating a deactivated system account whose role another account now holds is refused (service and bank route)', async () => {
    const OLD = randomUUID();
    await ins(OLD, '1105', 'asset', 'bank', true);
    await fx.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [OLD]);
    const tx = await fx.openTx();
    const service = await tx.run(() => updateAccount(CO, OLD, { isActive: true })).then(() => 'reactivated', (e: Error) => e.message);
    await tx.commit();
    const put = await fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: OLD, isActive: true });
    expect({ service, put: put.statusCode, bank: await holders('bank') })
      .toEqual({ service: expect.stringContaining('1110 now holds'), put: 400, bank: ['1110'] });
  });

  it('reactivating a deactivated system account whose role is empty is allowed: it holds the role again', async () => {
    const OLD_AR = randomUUID();
    await fx.query('DELETE FROM gl_accounts WHERE id = $1', [AR]);
    await ins(OLD_AR, '1125', 'asset', 'receivable', true);
    await fx.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [OLD_AR]);
    const tx = await fx.openTx();
    await tx.run(() => updateAccount(CO, OLD_AR, { isActive: true }));
    await tx.commit();
    expect(await holders('receivable')).toEqual(['1125']);
  });
});
