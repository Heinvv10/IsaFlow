// Ported from the adversarial round on PR #593 at 2ce8f234d (brk-593, claim 1); each case asserts
// the claim, so it was RED where the breaker broke it. Changes from the breaker's file are marked "Ported note".
// brk-593 claim 1 (EXACTLY ONE HOLDER). Each test asserts the claim; a failure is a break.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { brkFixture, show } from './w2-28-brk593.helpers';
import coa from '../../pages/api/accounting/chart-of-accounts';
import coaDetail from '../../pages/api/accounting/chart-of-accounts-detail';
import coaImport from '../../pages/api/accounting/migration/chart-of-accounts';
import { createSession } from '@/modules/accounting/services/core/migrationService';

const fx = brkFixture('BRK593C1');
const { CO, USER, ins, holders } = fx;
const AR = randomUUID(); const BANK = randomUUID(); const X = randomUUID(); const OLD = randomUUID();

describe('brk-593 claim 1: exactly one holder', () => {
  beforeAll(fx.setup);
  beforeEach(async () => {
    await fx.wipe();
    await ins(AR, '1120', 'asset', 'receivable', true);
    await ins(BANK, '1110', 'asset', 'bank', true);
    await ins(X, '1115', 'asset', null, false);
  });
  afterAll(fx.teardown);

  it('1a PUT /chart-of-accounts {isActive:"false"} on the bank holder must not empty the bank role', async () => {
    const r = await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: BANK, isActive: 'false' });
    const bank = await holders('bank');
    show('1a', { status: r.statusCode, body: r.body, bankHolders: bank, rows: await fx.rows() });
    expect(bank).toEqual(['1110']);
  });

  it('1b PUT /chart-of-accounts-detail {isActive:0} on the receivable holder must not empty the role', async () => {
    const r = await fx.call(coaDetail, 'PUT', '/api/accounting/chart-of-accounts-detail', { id: AR, isActive: 0 });
    const ar = await holders('receivable');
    show('1b', { status: r.statusCode, body: r.body, receivableHolders: ar });
    expect(ar).toEqual(['1120']);
  });

  it('1c PUT /chart-of-accounts {isActive:"true"} on a deactivated former holder must not double the role', async () => {
    await ins(OLD, '1105', 'asset', 'bank', true, { active: false });
    const honest = await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: OLD, isActive: true });
    const r = await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: OLD, isActive: 'true' });
    const bank = await holders('bank');
    show('1c', { honestBooleanStatus: honest.statusCode, stringStatus: r.statusCode, bankHolders: bank });
    expect(bank).toEqual(['1110']);
  });

  const importCoa = async (accounts: unknown[], systemAccountMap: Record<string, string>) => {
    const session = await createSession(CO, 'sage', USER);
    return fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id, accounts, systemAccountMap });
  };

  it('1d COA import: a role mapped to a row the import SKIPS (parent code not found) must not empty the role', async () => {
    const r = await importCoa(
      [{ accountCode: '1999', accountName: 'New bank', accountType: 'asset', normalBalance: 'debit', parentCode: 'NOPE' }],
      { bank: '1999' });
    const bank = await holders('bank');
    show('1d', { status: r.statusCode, body: r.body, bankHolders: bank, rows: await fx.rows() });
    expect(bank).toHaveLength(1);
  });

  it('1e COA import: a role mapped to an existing INACTIVE account must not empty the role', async () => {
    await fx.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [X]);
    const r = await importCoa(
      [{ accountCode: '1115', accountName: 'Dormant', accountType: 'asset', normalBalance: 'debit' }],
      { bank: '1115' });
    const bank = await holders('bank');
    show('1e', { status: r.statusCode, body: r.body, bankHolders: bank, rows: await fx.rows() });
    expect(bank).toHaveLength(1);
  });

  it('1f COA re-import: a row that names a role holder with another subtype (no role map) must not empty the role', async () => {
    const r = await importCoa(
      [{ accountCode: '1120', accountName: 'Debtors', accountType: 'asset', normalBalance: 'debit', accountSubtype: 'inventory' }], {});
    const ar = await holders('receivable');
    show('1f', { status: r.statusCode, body: r.body, receivableHolders: ar, rows: await fx.rows() });
    expect(ar).toEqual(['1120']);
  });

  it('1g COA re-import: a row that re-types a role holder (asset -> expense) must not leave the role on a wrong-type account', async () => {
    const r = await importCoa(
      [{ accountCode: '1120', accountName: 'Debtors', accountType: 'expense', normalBalance: 'debit' }], {});
    const row = (await fx.rows()).find((x) => x.code === '1120');
    show('1g', { status: r.statusCode, body: r.body, row });
    expect(row).toMatchObject({ type: 'asset', sub: 'receivable', sys: true });
  });
});
