// Ported from the adversarial round's second pass on PR #593 at 031cd38ae (brk-593/pass2); each case asserts
// the claim, so it was RED where the breaker broke it. Changes from the breaker's file are marked "Ported note".
// brk-593 pass 2: legitimate operations a real user does today. Each must still succeed with every role on one holder.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { brkFixture, show } from './w2-28-brk593.helpers';
import coa from '../../pages/api/accounting/chart-of-accounts';
import bankAccounts from '../../pages/api/accounting/bank-accounts';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import coaSeed from '../../pages/api/accounting/coa-seed';
import coaImport from '../../pages/api/accounting/migration/chart-of-accounts';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { SYSTEM_ACCOUNT_KEYS } from '@/modules/accounting/services/gl/systemAccountKeys';

const fx = brkFixture('BRK593P2L');
const { CO, USER } = fx;
const doubled = async () => {
  const out: Record<string, string[]> = {};
  for (const k of SYSTEM_ACCOUNT_KEYS) {
    const h = (await fx.query(`SELECT account_code FROM gl_accounts WHERE company_id = $1 AND account_subtype = $2 AND is_system_account AND is_active ORDER BY 1`, [CO, k])).rows.map((r) => r.account_code);
    if (h.length > 1) out[k] = h;
  }
  return out;
};
const empty = async () => {
  const out: string[] = [];
  for (const k of SYSTEM_ACCOUNT_KEYS) {
    const n = (await fx.query(`SELECT count(*)::int AS n FROM gl_accounts WHERE company_id = $1 AND account_subtype = $2 AND is_system_account AND is_active`, [CO, k])).rows[0].n;
    if (n === 0) out.push(k);
  }
  return out;
};
const tree = async () => (await fx.query(`SELECT count(*)::int AS n, count(parent_account_id)::int AS with_parent FROM gl_accounts WHERE company_id = $1`, [CO])).rows[0];

describe('brk-593 pass 2: legitimate operations', () => {
  beforeAll(fx.setup);
  beforeEach(async () => { await fx.wipe(); clearSystemAccountCache(CO); });
  afterAll(fx.teardown);

  for (const template of ['isaflow_standard', 'xero_compatible', 'sage_compatible']) {
    it(`L1 onboarding: company-create seed + coa-seed '${template}' succeeds, no role doubled, then a first CoA import moving every mappable role succeeds`, async () => {
      await fx.query('SELECT seed_company_chart_of_accounts($1)', [CO]);
      const afterDbSeed = { tree: await tree(), empty: await empty() };
      const seed = await fx.call(coaSeed, 'POST', '/api/accounting/coa-seed', { template });
      const afterSeed = { tree: await tree(), doubled: await doubled(), empty: await empty() };
      const rows = [
        ['B100', 'FNB Cheque', 'asset', 'debit'], ['B200', 'Trade Debtors', 'asset', 'debit'], ['B300', 'Trade Creditors', 'liability', 'credit'],
        ['B400', 'VAT Input', 'asset', 'debit'], ['B500', 'VAT Output', 'liability', 'credit'], ['B600', 'Retained Income', 'equity', 'credit'],
        ['B700', 'Sales', 'revenue', 'credit'], ['B800', 'Purchases', 'expense', 'debit'],
      ].map(([accountCode, accountName, accountType, normalBalance]) => ({ accountCode, accountName, accountType, normalBalance }));
      const session = await createSession(CO, 'sage', USER);
      const imp = await fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id, accounts: rows,
        systemAccountMap: { bank: 'B100', receivable: 'B200', payable: 'B300', vat_input: 'B400', vat_output: 'B500', retained_earnings: 'B600', default_revenue: 'B700', default_expense: 'B800' } });
      const data = (imp.body as { data?: { imported?: number; errors?: unknown[] } }).data;
      const afterImport = { status: imp.statusCode, imported: data?.imported, errors: JSON.stringify(data?.errors ?? []).slice(0, 400), doubled: await doubled(), empty: await empty() };
      show(`L1 ${template}`, { afterDbSeed, seed: seed.statusCode, afterSeed, afterImport });
      expect(seed.statusCode).toBe(200);
      expect(afterSeed.doubled).toEqual({});
      expect(afterImport.imported).toBe(rows.length);
      expect(afterImport.doubled).toEqual({});
    }, 60_000);
  }

  it('L2 bank setup: add a bank, make it primary, add a second bank, group it, (de)activate the old one', async () => {
    await fx.query('SELECT seed_company_chart_of_accounts($1)', [CO]);
    await fx.call(coaSeed, 'POST', '/api/accounting/coa-seed', { template: 'isaflow_standard' });
    const primary = (await fx.query(`SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'bank' AND is_system_account AND is_active`, [CO])).rows[0]?.id;
    const steps: Record<string, unknown> = {};
    const nb = await fx.call(coa, 'POST', '/api/accounting/chart-of-accounts', { accountCode: '1190', accountName: 'Nedbank', accountType: 'asset', accountSubtype: 'bank', normalBalance: 'debit' });
    steps.createBank = nb.statusCode;
    const nbId = (nb.body as { data?: { id?: string } }).data?.id;
    steps.makePrimary = (await fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', { mappings: { primary_bank: nbId }, loaded: { primary_bank: primary } })).statusCode;
    const sb = await fx.call(coa, 'POST', '/api/accounting/chart-of-accounts', { accountCode: '1191', accountName: 'Nedbank call', accountType: 'asset', accountSubtype: 'bank', normalBalance: 'debit' });
    steps.createSecond = sb.statusCode;
    const sbId = (sb.body as { data?: { id?: string } }).data?.id;
    steps.groupUnderOldBank = (await fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: sbId, parentAccountId: primary })).statusCode;
    steps.groupUnderNewPrimary = (await fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: sbId, parentAccountId: nbId })).statusCode;
    steps.renameNewPrimary = (await fx.call(bankAccounts, 'PUT', '/api/accounting/bank-accounts', { id: nbId, accountName: 'Nedbank Business', bankName: 'Nedbank' })).statusCode;
    show('L2', { steps, doubled: await doubled() });
    expect({ createBank: steps.createBank, makePrimary: steps.makePrimary, createSecond: steps.createSecond, renameNewPrimary: steps.renameNewPrimary })
      .toEqual({ createBank: 200, makePrimary: 200, createSecond: 200, renameNewPrimary: 200 });
  }, 60_000);
});
