// Ported from the adversarial round on PR #593 at 2ce8f234d (brk-593, claim 1 and 4); each case asserts
// the claim, so it was RED where the breaker broke it. Changes from the breaker's file are marked "Ported note".
// brk-593: further attempts on claim 1 (seed, import doubling) and claim 4 (posting, cross-company).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { brkFixture, show, sleep, within } from './w2-28-brk593.helpers';
import { drainAfterCommit } from '@/lib/afterCommit';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import coaSeed from '../../pages/api/accounting/coa-seed';
import coaImport from '../../pages/api/accounting/migration/chart-of-accounts';
import coaDetail from '../../pages/api/accounting/chart-of-accounts-detail';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { SYSTEM_ACCOUNT_KEYS } from '@/modules/accounting/services/gl/systemAccountKeys';

const fx = brkFixture('BRK593C14');
const other = brkFixture('BRK593C14B');
const { CO, USER, ins, holders } = fx;
const AR = '00000000-0000-4000-8000-' + randomUUID().slice(-12);
const BANK = '11111111-1111-4111-8111-' + randomUUID().slice(-12);
const X = 'ffffffff-ffff-4fff-bfff-' + randomUUID().slice(-12);     // the chosen account: last by id
const OX = randomUUID(); const OBANK = randomUUID();
const save = (f = fx, mappings: Record<string, unknown> = { primary_bank: X }, loaded: Record<string, unknown> = { primary_bank: BANK }) =>
  f.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', { mappings, loaded });
const roleCounts = async () => {
  const out: Record<string, string[]> = {};
  for (const k of SYSTEM_ACCOUNT_KEYS) { const h = await holders(k); if (h.length !== 1) out[k] = h; }
  return out;   // only roles that do NOT have exactly one holder
};

describe('brk-593 claims 1 and 4: more attempts', () => {
  beforeAll(async () => { await fx.setup(); await other.setup(); });
  beforeEach(async () => {
    await fx.wipe(); await other.wipe(); clearSystemAccountCache(CO);
    await fx.query('DELETE FROM fiscal_periods WHERE company_id = $1', [CO]);
    await ins(AR, '1120', 'asset', 'receivable', true);
    await ins(BANK, '1110', 'asset', 'bank', true);
    await ins(X, '1115', 'asset', null, false);
  });
  afterAll(async () => { await fx.query('DELETE FROM fiscal_periods WHERE company_id = $1', [CO]); await fx.teardown(); await other.teardown(); });

  it('1h COA re-import: a row that names one role holder with ANOTHER role as its subtype must not double that role', async () => {
    const session = await createSession(CO, 'sage', USER);
    const r = await fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id,
      accounts: [{ accountCode: '1120', accountName: 'Debtors', accountType: 'asset', normalBalance: 'debit', accountSubtype: 'bank' }], systemAccountMap: {} });
    const out = { status: r.statusCode, body: r.body, bank: await holders('bank'), receivable: await holders('receivable') };
    show('1h', out);
    expect({ bank: out.bank, receivable: out.receivable }).toEqual({ bank: ['1110'], receivable: ['1120'] });
  });

  it('1i template seed (each template, twice, over a chart that already holds roles under other codes) never doubles a role', async () => {
    const before = { bank: await holders('bank'), receivable: await holders('receivable') };
    const statuses: number[] = [];
    for (const template of ['isaflow_standard', 'xero_compatible', 'sage_compatible', 'isaflow_standard']) {
      statuses.push((await fx.call(coaSeed, 'POST', '/api/accounting/coa-seed', { template })).statusCode);
    }
    const notOne = await roleCounts();
    const doubled = Object.fromEntries(Object.entries(notOne).filter(([, h]) => h.length > 1));
    show('1i', { statuses, before, after: { bank: await holders('bank'), receivable: await holders('receivable') }, rolesNotExactlyOne: notOne });
    expect(doubled).toEqual({});
    expect({ bank: await holders('bank'), receivable: await holders('receivable') }).toEqual(before);
  }, 60_000);

  it('1j two saves racing to opposite accounts, and a save racing a delete of its chosen account: one holder, never zero', async () => {
    const Y = randomUUID(); await ins(Y, '1116', 'asset', null, false);
    const [a, b] = await Promise.all([save(), save(fx, { primary_bank: Y })]);
    const afterRace = await holders('bank');
    const holderId = afterRace[0] === '1115' ? X : Y; const free = holderId === X ? Y : X;
    const [s, d] = await Promise.all([
      save(fx, { primary_bank: free }, { primary_bank: holderId }),
      fx.call(coaDetail, 'DELETE', '/api/accounting/chart-of-accounts-detail', { id: free }),
    ]);
    const end = await holders('bank');
    show('1j', { saves: [a.statusCode, b.statusCode], afterRace, saveVsDelete: [s.statusCode, d.statusCode], end, rows: await fx.rows() });
    expect(afterRace).toHaveLength(1); expect(end).toHaveLength(1);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });

  it('4f posting through the real posting service on the role accounts neither waits for nor deadlocks with a save in flight', async () => {
    await fx.query(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES ($1, 'FY26 brk', 1, 2026, '2026-01-01', '2026-12-31', 'open')`, [CO]);
    // Hold the save with its role-write lock and its locks on the role rows (AR, BANK): it waits on X, last by id.
    const c: PoolClient = await fx.connect();
    await c.query('BEGIN'); await c.query('SELECT 1 FROM gl_accounts WHERE id = $1 FOR UPDATE', [X]);
    try {
      const saving = save();
      for (let i = 0; i < 100; i++) {
        if ((await fx.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%FOR NO KEY UPDATE%'")).rows[0].n > 0) break;
        await sleep(50);
      }
      const t0 = Date.now();
      const tx = await fx.openTx(drainAfterCommit);
      const posted = await within(4000, tx.run(async () => {
        const e = await createJournalEntry(CO, { entryDate: '2026-06-10', description: 'brk593 posting', source: 'manual', lines: [
          { glAccountId: BANK, debit: 60, credit: 0, description: 'a' }, { glAccountId: BANK, debit: 40, credit: 0, description: 'b' },
          { glAccountId: AR, debit: 0, credit: 100, description: 'c' }] } as never, USER);
        const p = await postJournalEntry(CO, e.id, USER);
        return p.status;
      }).then((s) => s, (e: Error & { code?: string }) => `failed ${e.code ?? ''} ${e.message}`));
      const ms = Date.now() - t0;
      await (typeof posted === 'string' && posted.startsWith('STILL') ? tx.rollback() : tx.commit());
      await c.query('ROLLBACK');
      const s = await saving;
      show('4f', { posted, postingMs: ms, save: s.statusCode, bank: await holders('bank') });
      expect({ posted, save: s.statusCode }).toEqual({ posted: 'posted', save: 200 });
      expect(ms).toBeLessThan(1500);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  }, 30_000);

  it('4g company B is not held up while company A\'s role-write lock and role rows are held', async () => {
    await other.ins(OBANK, '1110', 'asset', 'bank', true);
    await other.ins(OX, '1115', 'asset', null, false);
    const c: PoolClient = await fx.connect();
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1::TEXT, 0))', [`default-accounts:${CO}`]);
    await c.query('SELECT 1 FROM gl_accounts WHERE company_id = $1 FOR UPDATE', [CO]);
    try {
      const t0 = Date.now();
      const b = await within(3000, save(other, { primary_bank: OX }, { primary_bank: OBANK }));
      const del = await within(3000, other.call(coaDetail, 'DELETE', '/api/accounting/chart-of-accounts-detail', { id: OBANK }));
      show('4g', { companyBSave: typeof b === 'string' ? b : b.statusCode, companyBDeleteOldHolder: typeof del === 'string' ? del : del.statusCode, ms: Date.now() - t0, companyBBank: await other.holders('bank') });
      expect(typeof b === 'string' ? b : b.statusCode).toBe(200);
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally { await c.query('ROLLBACK'); c.release(); }
  }, 30_000);
});
