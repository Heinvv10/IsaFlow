// W2-28 round 4: the five breaker repros (brk593c), each now stating the rule
// that holds. Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
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
import { getSystemAccount, clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { getSystemRoleCoverage } from '../../src/modules/accounting/services/gl/systemRoleCoverage';
import { updateAccount } from '../../src/modules/accounting/services/gl/chartOfAccountsService';
import { ensureOpeningBalanceEquityAccount } from '../../src/modules/accounting/services/gl/openingBalanceEquityService';
import { resolveRetainedEarnings } from '../../src/modules/accounting/services/gl/yearEndJournalBuilder';
import { lockGlAccountsForUpdate } from '../../src/modules/accounting/services/gl/glAccountLock';
import { importChartOfAccounts, type AccountImportRow } from '../../src/modules/accounting/services/core/migrationCoaService';
import { createSession } from '../../src/modules/accounting/services/core/migrationService';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const fx = roleWriterFixture('W228R4');
const { CO, USER, ins, holders } = fx;
const save = (body: Record<string, unknown>) => fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', body);
const resolved = async (role: 'bank' | 'opening_balance_equity') => {
  try { return (await getSystemAccount(role, CO)).accountCode; } catch (e) { return (e as Error).name; }
};

describeIfDb('W2-28 system role writers', () => {
  beforeAll(fx.setup);
  beforeEach(async () => { gate = null; await fx.wipe(); clearSystemAccountCache(CO); });
  afterAll(fx.teardown);

  it('a save naming a contested role\'s holder settles the role on that one account, and year-end resolves', async () => {
    const BANK = randomUUID(); const BANK2 = randomUUID(); const RE1 = randomUUID(); const RE2 = randomUUID();
    await ins(BANK, '1110', 'asset', 'bank', true);
    await ins(BANK2, '1111', 'asset', null, false);
    await ins(RE1, '3200', 'equity', 'retained_earnings', true, { createdAt: '2024-01-01' });
    await ins(RE2, '3210', 'equity', 'retained_earnings', true, { createdAt: '2025-01-01' });
    const shownRe = (await getSystemRoleCoverage(CO)).roles.find((r) => r.key === 'retained_earnings')!.holder!.id;
    const bank = await save({ mappings: { primary_bank: BANK2 }, loaded: { primary_bank: BANK } });
    const re = await save({ mappings: { retained_earnings: shownRe }, loaded: { retained_earnings: shownRe } });
    clearSystemAccountCache(CO);
    const close = await resolveRetainedEarnings(CO);
    expect({ bank: bank.statusCode, re: re.statusCode, reHolders: await holders('retained_earnings'),
      yearEnd: 'error' in close ? close.error : 'ok' })
      .toEqual({ bank: 200, re: 200, reHolders: ['3210'], yearEnd: 'ok' });
  });

  it('deactivating the account a save is moving a role to waits for the save and is then refused', async () => {
    const BANK = randomUUID(); const X = randomUUID();
    await ins(BANK, '1110', 'asset', 'bank', true);
    await ins(X, '1115', 'asset', null, false);
    const g = makeGate(); gate = g.gate;
    const saving = save({ mappings: { primary_bank: X }, loaded: { primary_bank: BANK } });
    await g.reached;                                  // the save holds the role lock and X, uncommitted
    const tx = await fx.openTx();                     // the chart edit form / MCP update_gl_account request
    const deact = tx.run(() => updateAccount(CO, X, { isActive: false }))
      .then(() => 'deactivated', (e: Error) => e.message);
    await sleep(300);
    g.release();
    const res = await saving; const outcome = await deact;
    await tx.commit();
    clearSystemAccountCache(CO);
    expect({ save: res.statusCode, outcome, bankHolders: await holders('bank'), resolved: await resolved('bank') })
      .toEqual({ save: 200, outcome: 'Cannot deactivate a system account', bankHolders: ['1115'], resolved: '1115' });
  });

  it('a save waits for an in-flight Opening Balance Equity auto-create: the role never has two holders', async () => {
    const X = randomUUID();
    await ins(X, '3350', 'equity', null, false, { createdAt: '2025-01-01' });
    const tx = await fx.openTx();                     // MCP set_opening_balance, request still open
    try {
      const created = await tx.run(() => ensureOpeningBalanceEquityAccount(CO));
      const saving = save({ mappings: { opening_balance_equity: X } }); // the page showed "not configured"
      await sleep(300);
      await tx.commit();
      const res = await saving;                       // sees 3300 now: stale page, not a second holder
      clearSystemAccountCache(CO);
      expect({ created: created.accountCode, save: res.statusCode, holders: await holders('opening_balance_equity'),
        resolved: await resolved('opening_balance_equity') })
        .toEqual({ created: '3300', save: 409, holders: ['3300'], resolved: '3300' });
    } finally { await tx.rollback(); }
  }, 20_000);

  it('a COA import clears the resolver cache only after its request commits, so no stale holder is cached', async () => {
    const rows = (codes: string[]) => codes.map((code) => ({ accountCode: code, accountName: `Bank ${code}`,
      accountType: 'asset', normalBalance: 'debit' }) as unknown as AccountImportRow);
    const s1 = await createSession(CO, 'sage', USER);
    const first = await importChartOfAccounts(CO, s1.id, rows(['1000', '1010']), { bank: '1000' } as never);
    expect(first.errors).toEqual([]);
    clearSystemAccountCache(CO);
    expect(await resolved('bank')).toBe('1000');
    const s2 = await createSession(CO, 'sage', USER);
    const tx = await fx.openTx();                     // the import request's transaction
    try {
      const out = await tx.run(() => importChartOfAccounts(CO, s2.id, rows(['1000', '1010']), { bank: '1010' } as never));
      expect(out.errors).toEqual([]);
      const midRequest = await resolved('bank');      // a bank-feed post, before the COMMIT
      await tx.commit();
      const afterCommit = await resolved('bank');
      expect({ midRequest, afterCommit, db: await holders('bank') })
        .toEqual({ midRequest: '1000', afterCommit: '1010', db: ['1010'] });
    } finally { await tx.rollback(); }
  });

  it('an account merge takes the role lock before its row locks, so a save queues behind it instead of deadlocking', async () => {
    const C = '00000000-0000-4000-8000-' + randomUUID().slice(-12);    // child of SRC, subtype receivable, not system
    const SRC = '11111111-1111-4111-8111-' + randomUUID().slice(-12);  // level-2 header, no subtype
    const TGT = 'ffffffff-ffff-4fff-bfff-' + randomUUID().slice(-12);  // receivable holder
    await ins(SRC, '1100', 'asset', null, false, { level: 2 });
    await ins(C, '1101', 'asset', 'receivable', false, { parent: SRC });
    await ins(TGT, '1120', 'asset', 'receivable', true);
    const tx = await fx.openTx();
    let mergeErr = '';
    try {
      await tx.run(() => lockGlAccountsForUpdate(CO, [SRC, TGT]));       // mergeAccounts step 1
      const saving = save({ mappings: { accounts_receivable: C }, loaded: { accounts_receivable: TGT } });
      await sleep(300);
      try {                                                               // mergeAccounts: children move to target
        await tx.run(async () => { await sql`
          UPDATE gl_accounts SET parent_account_id = ${TGT}::UUID, updated_at = NOW()
          WHERE company_id = ${CO}::UUID AND parent_account_id = ${SRC}::UUID`; });
      } catch (e) { mergeErr = (e as { code?: string }).code ?? String(e); }
      await tx.rollback();
      const res = await saving;
      expect({ save: res.statusCode, mergeErr }).toEqual({ save: 200, mergeErr: '' });
    } finally { await tx.rollback(); }
  }, 20_000);
});
