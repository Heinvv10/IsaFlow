/**
 * The bulk writers of account attributes, against a locked VAT period.
 *
 * Each rewrites account_type / account_subtype for SEVERAL accounts in one
 * request, and the filed VAT201 classified every posted line by those
 * attributes. So each checks every account whose attributes change
 * (vatLockLineClassification) BEFORE its first write, and refuses naming the
 * account and the period:
 *
 *   - pages/api/accounting/default-accounts.ts POST (marks the role's system
 *     account, setting its subtype) — through the real route handler;
 *   - migrationCoaService.importChartOfAccounts (upsert re-types; the role map
 *     DEMOTES the previous system account's subtype);
 *   - migrationExecuteService.executeMigration (re-import of the same source
 *     re-types its own accounts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { importChartOfAccounts, type AccountImportRow } from '@/modules/accounting/services/core/migrationCoaService';
import { executeMigration } from '@/modules/accounting/services/core/migrationExecuteService';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import defaultAccounts from '../../pages/api/accounting/default-accounts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

type Row = Record<string, unknown>;
let fx: Fixture;
let token = '';
let seq = 0;

async function addAccount(code: string, type: string, subtype: string | null, importedFrom: string | null = null) {
  return String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                             normal_balance, is_active, imported_from)
    VALUES (${fx.companyId}::UUID, ${code}, ${`${code} ${fx.tag}`}, ${type}, ${subtype}, 'debit', true, ${importedFrom})
    RETURNING id`) as Row[])[0]!.id);
}

/** A posted journal inside the lock: DR `accountId` 40 (optionally VAT-coded), CR bank. */
async function lockedLine(accountId: string, vatType: string | null = null) {
  const je = String(((await sql`
    INSERT INTO gl_journal_entries
      (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at, source)
    VALUES (${fx.companyId}::UUID, ${`VLW-${++seq}-${fx.tag}`}, '2026-06-10', 'orig', 'posted', ${fx.userId}::UUID,
            (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID LIMIT 1), NOW(), 'manual')
    RETURNING id`) as Row[])[0]!.id);
  await sql`
    INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description, vat_type)
    VALUES (${fx.companyId}::UUID, ${je}::UUID, ${accountId}::UUID, 40, 0, 'dr', ${vatType}),
           (${fx.companyId}::UUID, ${je}::UUID, ${fx.bankAccountId}::UUID, 0, 40, 'bank', NULL)`;
}

/** A posted journal inside the lock with the given lines. */
async function lockedJournal(lines: { account: string; debit: number; credit: number; vatType: string | null }[]) {
  const je = String(((await sql`
    INSERT INTO gl_journal_entries
      (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at, source)
    VALUES (${fx.companyId}::UUID, ${`VLW-${++seq}-${fx.tag}`}, '2026-06-11', 'orig', 'posted', ${fx.userId}::UUID,
            (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID LIMIT 1), NOW(), 'manual')
    RETURNING id`) as Row[])[0]!.id);
  for (const l of lines) {
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description, vat_type)
      VALUES (${fx.companyId}::UUID, ${je}::UUID, ${l.account}::UUID, ${l.debit}, ${l.credit}, 'l', ${l.vatType})`;
  }
}

const attrs = async (id: string) => ((await sql`
  SELECT account_type, account_subtype, is_system_account FROM gl_accounts WHERE id = ${id}::UUID`) as Row[])[0]!;
const idOf = async (code: string) => String(((await sql`
  SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_code = ${code}`) as Row[])[0]!.id);

describeIfDb('bulk account-attribute writers against a locked VAT period', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test rewrites account attributes.');
    fx = await seedFixture('VLW', DATABASE_URL!);
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`vlw-${fx.userId}@isaflow.test`}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${fx.companyId}::UUID, ${fx.userId}, 'admin')`;
    await sql`
      INSERT INTO vat_period_locks
        (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
      VALUES (${fx.companyId}::UUID, '2026-05-01', '2026-06-30', 0, 0, 0, '2026-06-30', ${fx.userId})`;
    token = await new SignJWT({ sub: fx.userId, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 120000);

  afterAll(async () => {
    const c = fx.companyId;
    clearSystemAccountCache(c);
    await sql`DELETE FROM vat_period_locks WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM app_settings WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM migration_sessions WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM company_users WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM users WHERE id = ${fx.userId}`;
    await dropFixture(fx);
  }, 120000);

  it('default-accounts: refuses making a VAT-coded asset the bank account, naming account and period, writing nothing', async () => {
    const card = await addAccount('1300', 'asset', null);
    await lockedLine(card, 'standard');
    const req = request({ 'sb-access-token': token, active_company_id: fx.companyId }, 'POST') as never as
      { body: unknown; query: Record<string, string>; url: string };
    req.body = { mappings: { primary_bank: card } };
    req.query = {};
    req.url = '/api/accounting/default-accounts';
    const out = response();
    await defaultAccounts(req as never, out.res as never);
    expect(out.state.statusCode).toBe(400);
    expect(JSON.stringify(out.state.body)).toMatch(/1300.*2026-05-01 to 2026-06-30/);
    expect(await attrs(card)).toMatchObject({ account_subtype: null, is_system_account: false });
    const settings = (await sql`SELECT 1 FROM app_settings WHERE company_id = ${fx.companyId}::UUID`) as Row[];
    expect(settings).toHaveLength(0);
  });

  describe('importChartOfAccounts (Sage COA re-import)', () => {
    const rows = (vatInputCode: string, extra: Partial<AccountImportRow>[] = []): AccountImportRow[] => [
      { accountCode: '1000', accountName: 'Bank', accountType: 'asset', normalBalance: 'debit' },
      { accountCode: '1100', accountName: 'AR', accountType: 'asset', normalBalance: 'debit' },
      { accountCode: '2100', accountName: 'AP', accountType: 'liability', normalBalance: 'credit' },
      { accountCode: '1140', accountName: 'VAT Input', accountType: 'asset', normalBalance: 'debit' },
      { accountCode: '1150', accountName: 'VAT Input new', accountType: 'asset', normalBalance: 'debit' },
      { accountCode: '2120', accountName: 'VAT Output', accountType: 'liability', normalBalance: 'credit' },
      { accountCode: '3200', accountName: 'RE', accountType: 'equity', normalBalance: 'credit' },
      { accountCode: '4000', accountName: 'Sales', accountType: 'revenue', normalBalance: 'credit' },
      { accountCode: '6000', accountName: 'Expense', accountType: 'expense', normalBalance: 'debit' },
      { accountCode: '6100', accountName: 'Admin', accountType: 'expense', normalBalance: 'debit' },
      ...extra,
    ].map((r) => ({ ...r, accountType: r.accountType as never, normalBalance: r.normalBalance as never }) as AccountImportRow)
      .filter((r) => r.accountCode !== (vatInputCode === '1140' ? '1150' : ''));
    const map = (vatInputCode: string) => ({
      bank: '1000', receivable: '1100', payable: '2100', vat_input: vatInputCode, vat_output: '2120',
      retained_earnings: '3200', default_revenue: '4000', default_expense: '6000', admin_expense: '6100',
    });

    it('refuses a re-import that DEMOTES the VAT input account holding a locked line, naming it', async () => {
      const vatInput = await idOf('1140');
      await lockedLine(vatInput);
      const out = await inTx(fx, () => importChartOfAccounts(fx.companyId, randomUUID(), rows('1150'), map('1150')));
      expect(out.imported).toBe(0);
      expect(out.errors[0]!.message).toMatch(/1140.*2026-05-01 to 2026-06-30/);
      expect(await attrs(vatInput)).toMatchObject({ account_subtype: 'vat_input', is_system_account: true });
      expect((await sql`SELECT 1 FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_code = '1150'`) as Row[]).toHaveLength(0);
    });

    const retype = (code: string, over: Partial<AccountImportRow> = {}): Partial<AccountImportRow> =>
      ({ accountCode: code, accountName: code, accountType: 'expense' as never, normalBalance: 'debit' as never, ...over });

    /** M1 worked case: the debtors line keeps its class (settlement) but the
     *  journal LEAVES the return — its zero-rated sale leaves box 2. */
    it('refuses re-typing debtors to expense when that takes a zero-rated sale out of the filed return', async () => {
      const debtors = await addAccount('1410', 'asset', 'receivable');
      const sales = await addAccount('4100', 'revenue', 'revenue');
      await lockedJournal([
        { account: debtors, debit: 115, credit: 0, vatType: 'zero_rated' },
        { account: sales, debit: 0, credit: 115, vatType: 'zero_rated' },
      ]);
      const session = await createSession(fx.companyId, 'sage', fx.userId);
      const out = await inTx(fx, () => importChartOfAccounts(fx.companyId, session.id, rows('1140', [retype('1410')]), map('1140')));
      expect(out.imported).toBe(0);
      expect(out.errors[0]!.message).toMatch(/1410.*2026-05-01 to 2026-06-30/);
      expect(await attrs(debtors)).toMatchObject({ account_type: 'asset', account_subtype: 'receivable' });
    });

    /** Each re-type alone keeps the journal in the return (the other account
     *  still carries it); together they take it out. Judged with ALL of the
     *  import's changes applied at once. */
    it('refuses two re-types that are harmless apart but take a journal out of the return together', async () => {
      const a = await addAccount('1420', 'asset', 'receivable');
      const b = await addAccount('2420', 'liability', 'payable');
      await lockedJournal([
        { account: a, debit: 100, credit: 0, vatType: 'standard' },
        { account: b, debit: 0, credit: 100, vatType: 'standard' },
      ]);
      const session = await createSession(fx.companyId, 'sage', fx.userId);
      const out = await inTx(fx, () => importChartOfAccounts(fx.companyId, session.id,
        rows('1140', [retype('1420'), retype('2420')]), map('1140')));
      expect(out.imported).toBe(0);
      expect(out.errors[0]!.message).toMatch(/locked VAT period 2026-05-01 to 2026-06-30/);
      expect(await attrs(a)).toMatchObject({ account_type: 'asset' });
      expect(await attrs(b)).toMatchObject({ account_type: 'liability' });
    });

    /** L1: a row the import SKIPS writes nothing, so it cannot move a figure —
     *  judged on what the import actually wrote, not on what the rows said. */
    it('does not refuse over a row the import skips (missing parent)', async () => {
      const c = await addAccount('1430', 'asset', 'receivable');
      const s2 = await addAccount('4130', 'revenue', 'revenue');
      await lockedJournal([
        { account: c, debit: 115, credit: 0, vatType: 'zero_rated' },
        { account: s2, debit: 0, credit: 115, vatType: 'zero_rated' },
      ]);
      const session = await createSession(fx.companyId, 'sage', fx.userId);
      const out = await inTx(fx, () => importChartOfAccounts(fx.companyId, session.id,
        rows('1140', [retype('1430', { parentCode: 'NOPE' })]), map('1140')));
      expect(out.errors.some((e) => /locked VAT period/.test(e.message))).toBe(false);
      expect(out.errors.some((e) => /Parent code NOPE not found/.test(e.message))).toBe(true);
      expect(await attrs(c)).toMatchObject({ account_type: 'asset' });
    });

    it('lets a re-import that changes no locked classification through', async () => {
      const session = await createSession(fx.companyId, 'sage', fx.userId);
      const out = await inTx(fx, () => importChartOfAccounts(fx.companyId, session.id, rows('1140'), map('1140')));
      expect(out.errors.some((e) => /locked VAT period/.test(e.message))).toBe(false);
      expect(out.imported).toBeGreaterThan(0);
    });
  });

  // A VAT-coded line on an asset with no VAT treatment is 'unmapped' in the
  // filed return; re-typed to an expense (its NULL subtype filled from the
  // mapping) it would be a base line — a different box.
  it('executeMigration: refuses re-importing a source whose own account would be re-typed under a locked VAT line', async () => {
    const acct = await addAccount('XV1', 'asset', null, 'xero');
    await lockedLine(acct, 'standard');
    const out = await inTx(fx, () => executeMigration(fx.companyId, fx.userId, 'xero', [{
      sourceCode: 'XV1', sourceName: 'VAT', sourceType: 'EXPENSE', openingBalance: 0,
      mappedType: 'expense', mappedNormalBalance: 'debit', mappedSubtype: 'operating_expense',
    }], [], []));
    expect(out.accountsImported).toBe(0);
    expect(out.errors.join(' ')).toMatch(/XV1.*2026-05-01 to 2026-06-30/);
    expect(await attrs(acct)).toMatchObject({ account_type: 'asset', account_subtype: null });
  });

  /** Pre-write callers read every OTHER account's current attributes, so
   *  "together" is theirs to get right: each of these re-types alone leaves the
   *  journal in the return (the other account still carries it); both together
   *  take it out. */
  it('executeMigration: refuses two same-source re-types that take a journal out of the return only together', async () => {
    const a = await addAccount('XR1', 'asset', 'receivable', 'xero');
    const b = await addAccount('XP1', 'liability', 'payable', 'xero');
    await lockedJournal([
      { account: a, debit: 100, credit: 0, vatType: 'standard' },
      { account: b, debit: 0, credit: 100, vatType: 'standard' },
    ]);
    const asExpense = (code: string) => ({
      sourceCode: code, sourceName: code, sourceType: 'EXPENSE', openingBalance: 0,
      mappedType: 'expense' as const, mappedNormalBalance: 'debit' as const, mappedSubtype: 'operating_expense',
    });
    const out = await inTx(fx, () => executeMigration(fx.companyId, fx.userId, 'xero', [asExpense('XR1'), asExpense('XP1')], [], []));
    expect(out.accountsImported).toBe(0);
    expect(out.errors.join(' ')).toMatch(/into or out of that period's filed VAT201/);
    expect(await attrs(a)).toMatchObject({ account_type: 'asset' });
  });
});
