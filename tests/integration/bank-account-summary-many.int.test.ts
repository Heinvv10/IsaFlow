/**
 * WP5: the account switcher is only as good as the list under it. A company with 80 bank accounts (20 primaries and a
 * "Paycards" umbrella with 60 sub-accounts) gets every one of them back from the summaries the page reads, each with
 * its group fields, ledger balance and to-code count, in its own company only. Read as the bearer pipeline reads
 * (app_user, company GUC). Own fixture company; nothing else is touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getBankAccountSummaries } from '@/modules/accounting/services/bank/bankAccountSummaryService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { asToken, bankCompany, cleanupBankControlsA, type BankCompany } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';
let f: BankCompany;
let umbrella = '';
const planted: { primary: string[]; paycard: string[] } = { primary: [], paycard: [] };

async function bankAccount(code: string, name: string, parent: string | null): Promise<string> {
  return (await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype,parent_account_id,bank_account_number)
     VALUES($1,$2,$3,'asset','debit',true,'bank',$4,$5) RETURNING id`, [f.c, code, name, parent, `62${code}`])).rows[0].id as string;
}

beforeAll(async () => {
  user = await createUser(pool, tokens);
  f = await bankCompany(pool, [[user, 'admin']], companies);
  umbrella = await bankAccount('3000', 'Paycards', null);
  for (let i = 1; i <= 18; i++) planted.primary.push(await bankAccount(String(3100 + i), `Branch account ${i}`, null));
  for (let i = 1; i <= 60; i++) planted.paycard.push(await bankAccount(String(4000 + i), `Employee ${i} Paycard`, umbrella));
  // One line still to code on the first paycard and on the first primary.
  for (const id of [planted.paycard[0]!, planted.primary[0]!]) {
    await pool.query(`INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,status)
      VALUES($1,$2,DATE '2026-09-01',-250,'to code','imported')`, [f.c, id]);
  }
}, 120000);
afterAll(() => cleanupBankControlsA(pool, companies, [user]), 120000);

describe('bank-account-summaries with 80 bank accounts', () => {
  it('returns every account, the sub-accounts under their group, with ledger and to-code figures', async () => {
    const { accounts } = await asToken(pool, user, f.c, () => getBankAccountSummaries(f.c));
    const byId = new Map(accounts.map(a => [a.id, a]));
    // 2 from the fixture (bank, bank2) + 18 primaries + 60 paycards = 80; the umbrella is the group, not an account.
    expect(accounts).toHaveLength(80);
    expect(byId.has(umbrella)).toBe(false);
    for (const id of planted.paycard) {
      expect(byId.get(id)?.groupId, id).toBe(umbrella);
      expect(byId.get(id)?.groupName).toBe('Paycards');
    }
    for (const id of planted.primary) expect(byId.get(id)?.groupId).toBeNull();
    expect(byId.get(planted.paycard[0]!)?.counts.toCode).toBe(1);
    expect(byId.get(planted.paycard[0]!)?.toCodeOutCents).toBe(-25000);
    expect(byId.get(planted.primary[0]!)?.counts.toCode).toBe(1);
    expect(byId.get(planted.paycard[1]!)?.counts.toCode).toBe(0);
    expect(byId.get(planted.paycard[1]!)?.bankAccountNumber).toBe('624002');
    expect(Number.isSafeInteger(byId.get(planted.paycard[5]!)?.ledgerCents)).toBe(true);
  }, 60000);
});
