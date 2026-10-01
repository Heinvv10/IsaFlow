// Ported from the adversarial round on PR #593 at 2ce8f234d (brk-593, claim 2); each case asserts
// the claim, so it was RED where the breaker broke it. Changes from the breaker's file are marked "Ported note".
// brk-593 claim 2 (THE RESOLVER NEVER LIES). Each test asserts the claim; a failure is a break.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { brkFixture, show } from './w2-28-brk593.helpers';
import { drainAfterCommit } from '@/lib/afterCommit';
import coa from '../../pages/api/accounting/chart-of-accounts';
import coaDetail from '../../pages/api/accounting/chart-of-accounts-detail';
import bankAccounts from '../../pages/api/accounting/bank-accounts';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import coaImport from '../../pages/api/accounting/migration/chart-of-accounts';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { clearSystemAccountCache, getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { ensureOpeningBalanceEquityAccount } from '@/modules/accounting/services/gl/openingBalanceEquityService';

const fx = brkFixture('BRK593C2');
const { CO, USER, ins, holders } = fx;
const AR = randomUUID(); const BANK = randomUUID(); const X = randomUUID();
const resolve = (key: string) => getSystemAccount(key as never, CO)
  .then((a) => ({ id: a.id, code: a.accountCode }), (e: Error) => ({ threw: e.constructor.name }));

describe('brk-593 claim 2: the resolver never lies', () => {
  beforeAll(fx.setup);
  beforeEach(async () => {
    await fx.wipe(); clearSystemAccountCache(CO);
    await ins(AR, '1120', 'asset', 'receivable', true);
    await ins(BANK, '1110', 'asset', 'bank', true);
    await ins(X, '1115', 'asset', null, false);
  });
  afterAll(fx.teardown);

  it('2a bank-accounts PUT reactivates the only bank claimant (role empty -> held): next resolver call returns it', async () => {
    await fx.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [BANK]);
    const before = await resolve('bank');                       // a posting attempt while the role is empty
    const put = await fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: BANK, isActive: true });
    const after = await resolve('bank');
    show('2a', { before, put: put.statusCode, committedHolders: await holders('bank'), resolverAfter: after });
    expect(after).toEqual({ id: BANK, code: '1110' });
  });

  it('2b chart-of-accounts PUT reactivation (role empty -> held): next resolver call returns it', async () => {
    await fx.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [AR]);
    const before = await resolve('receivable');
    const put = await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: AR, isActive: true });
    const after = await resolve('receivable');
    show('2b', { before, put: put.statusCode, committedHolders: await holders('receivable'), resolverAfter: after });
    expect(after).toEqual({ id: AR, code: '1120' });
  });

  // Ported note: the breaker deactivated the holder through the "false" coercion. Round 6 closed
  // that (400, nothing written), and no other route can deactivate a holder, so the committed state
  // this case needed can no longer be produced. It now pins that: refused, and the resolver's answer
  // is still the (active) holder.
  it('2c the "false" coercion no longer deactivates the holder, so the resolver still (rightly) hands it out', async () => {
    const before = await resolve('bank');
    const put = await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: BANK, isActive: 'false' });
    const after = await resolve('bank');
    show('2c', { before, put: put.statusCode, committedHolders: await holders('bank'), resolverAfter: after });
    expect({ put: put.statusCode, holders: await holders('bank'), after }).toEqual({ put: 400, holders: ['1110'], after: { id: BANK, code: '1110' } });
  });

  it('2d (control) a committed save moves the role: resolver returns the new holder; a 409 and a 400 leave the old', async () => {
    const before = await resolve('bank');
    const stale = await fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', { mappings: { primary_bank: X }, loaded: { primary_bank: AR } });
    const afterStale = await resolve('bank');
    const bad = await fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', { mappings: { primary_bank: AR }, loaded: { primary_bank: BANK } });
    const afterBad = await resolve('bank');
    const ok = await fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', { mappings: { primary_bank: X }, loaded: { primary_bank: BANK } });
    const after = await resolve('bank');
    show('2d', { before, stale: stale.statusCode, afterStale, bad: bad.statusCode, afterBad, ok: ok.statusCode, after });
    expect({ stale: stale.statusCode, afterStale, bad: bad.statusCode, afterBad, ok: ok.statusCode, after })
      .toEqual({ stale: 409, afterStale: before, bad: 400, afterBad: before, ok: 200, after: { id: X, code: '1115' } });
  });

  it('2e (control) a committed COA import role move: resolver returns the new holder', async () => {
    const before = await resolve('bank');
    const session = await createSession(CO, 'sage', USER);
    const r = await fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id,
      accounts: [{ accountCode: '1115', accountName: 'New bank', accountType: 'asset', normalBalance: 'debit' }], systemAccountMap: { bank: '1115' } });
    const after = await resolve('bank');
    show('2e', { before, status: r.statusCode, after });
    expect(after).toEqual({ id: X, code: '1115' });
  });

  it('2f a holder change that is ROLLED BACK after the same transaction resolved it: resolver must still answer from committed state', async () => {
    const before = await resolve('opening_balance_equity');     // Missing — and now cached as missing
    clearSystemAccountCache(CO);                                // (cache expired / never filled)
    const tx = await fx.openTx(drainAfterCommit);
    const inTx = await tx.run(async () => {
      const created = await ensureOpeningBalanceEquityAccount(CO);
      return { created: created.id, resolved: await resolve('opening_balance_equity') };
    });
    await tx.rollback();                                        // the request failed (5xx): nothing committed
    const after = await resolve('opening_balance_equity');
    show('2f', { before, inTx, committedHolders: await holders('opening_balance_equity'), resolverAfterRollback: after });
    expect(after).toEqual({ threw: 'MissingSystemAccountError' });
  });

  it('2g a request that changes a holder and resolves it before committing sees its own change', async () => {
    const before = await resolve('opening_balance_equity');     // cached as missing (any earlier posting attempt does this)
    const tx = await fx.openTx(drainAfterCommit);
    const inTx = await tx.run(async () => {
      const created = await ensureOpeningBalanceEquityAccount(CO);
      return { created: created.id, resolved: await resolve('opening_balance_equity') };
    });
    await tx.commit();
    show('2g', { before, inTx, afterCommit: await resolve('opening_balance_equity') });
    expect(inTx.resolved).toMatchObject({ id: inTx.created });
  });

  it('2h a committed code rename of the holder: resolver returns the new code', async () => {
    const before = await resolve('bank');
    const r = await fx.call(coaDetail, 'PATCH', '/api/accounting/chart-of-accounts-detail', { id: BANK, accountCode: '1119' });
    const after = await resolve('bank');
    show('2h', { before, status: r.statusCode, after });
    expect(after).toEqual({ id: BANK, code: '1119' });
  });
});
