/**
 * A re-import never changes an existing account's TYPE (Hein, 2026-10-28). The chart import and the
 * Xero/QuickBooks/Pastel migration re-run both upserted `account_type = EXCLUDED.account_type`, so a file
 * that called a posted level-1 asset header an expense moved it off the balance sheet (and a racing journal
 * could post past headerAccountGuard's type filter). Now the row is refused and reported, the rest of the
 * import goes on, and the type is changed in the chart of accounts, where every chart rule runs.
 * Disposable databases only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { importChartOfAccounts, type AccountImportRow } from '@/modules/accounting/services/core/migrationCoaService';
import { executeMigration } from '@/modules/accounting/services/core/migrationExecuteService';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import type { ParsedAccount } from '@/modules/accounting/services/core/migrationParserService';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { addAccount, dropHeaderFixture, seedHeaderFixture, type HeaderFixture } from './helpers/headerGuardFixture';

const describeIfDb = isDisposableDb() ? describe : describe.skip;
type Row = Record<string, unknown>;
let h: HeaderFixture;

const account = async (code: string) => ((await sql`
  SELECT account_type, account_name, account_subtype FROM gl_accounts
   WHERE company_id = ${h.fx.companyId}::UUID AND account_code = ${code}`) as Row[])[0];

const importRows = (rows: AccountImportRow[]) => inTx(h.fx, async () => {
  const session = await createSession(h.fx.companyId, 'sage', h.fx.userId);
  return importChartOfAccounts(h.fx.companyId, session.id, rows, {} as never);
});
const coaRow = (accountCode: string, accountType: string, accountName: string): AccountImportRow =>
  ({ accountCode, accountName, accountType, normalBalance: accountType === 'asset' || accountType === 'expense' ? 'debit' : 'credit',
    accountSubtype: accountType === 'expense' ? 'operating_expense' : 'other_current_asset' } as AccountImportRow);

const rerun = (accounts: ParsedAccount[]) => inTx(h.fx, () => executeMigration(h.fx.companyId, h.fx.userId, 'xero', accounts, [], []));
const xeroRow = (sourceCode: string, mappedType: ParsedAccount['mappedType'], sourceName: string): ParsedAccount =>
  ({ sourceCode, sourceName, sourceType: 'X', openingBalance: 0, mappedType,
    mappedNormalBalance: mappedType === 'asset' || mappedType === 'expense' ? 'debit' : 'credit',
    mappedSubtype: mappedType === 'expense' ? 'operating_expense' : undefined });

describeIfDb('a re-import refuses to change an existing account\'s type', () => {
  beforeAll(async () => { h = await seedHeaderFixture('IRT', process.env.DATABASE_URL!); }, 120000);
  afterAll(async () => {
    await sql`DELETE FROM migration_sessions WHERE company_id = ${h.fx.companyId}::UUID`;
    await dropHeaderFixture(h);
  }, 120000);

  describe('chart import', () => {
    it('a row that re-types an account is refused whole; the other rows still import', async () => {
      await addAccount(h.fx, { code: 'IRT-A1', type: 'asset', level: 1 });
      await addAccount(h.fx, { code: 'IRT-A2', type: 'asset', level: 1 });
      const out = await importRows([coaRow('IRT-A1', 'expense', 'Now an expense'), coaRow('IRT-A2', 'asset', 'Renamed asset')]);
      expect({
        imported: out.imported, skipped: out.skipped,
        refusals: out.errors.filter((e) => e.severity !== 'warning').map((e) => ({ field: e.field, row: e.row, says: /IRT-A1 is an existing asset account; the file makes it expense/.test(e.message) })),
        a1: await account('IRT-A1'), a2: (await account('IRT-A2'))!.account_name,
      }).toEqual({
        imported: 1, skipped: 1,
        refusals: [{ field: 'accountType', row: expect.any(Number), says: true }],
        a1: { account_type: 'asset', account_name: `IRT-A1 name ${h.fx.tag}`, account_subtype: null },
        a2: 'Renamed asset',
      });
    });

    it('a system account is not refused: its name updates, its type and normal side are kept, with a warning', async () => {
      await addAccount(h.fx, { code: 'IRT-S1', type: 'asset', level: 3, subtype: 'petty_cash', system: true });
      const out = await importRows([{ ...coaRow('IRT-S1', 'expense', 'System renamed'), normalBalance: 'credit' } as AccountImportRow]);
      expect({
        imported: out.imported,
        warned: out.errors.some((e) => e.severity === 'warning' && /IRT-S1 is a system account/.test(e.message)),
        refused: out.errors.some((e) => e.severity !== 'warning'),
        s1: await account('IRT-S1'),
        side: ((await sql`SELECT normal_balance FROM gl_accounts WHERE company_id = ${h.fx.companyId}::UUID AND account_code = 'IRT-S1'`) as Row[])[0]!.normal_balance,
      }).toEqual({ imported: 1, warned: true, refused: false, s1: { account_type: 'asset', account_name: 'System renamed', account_subtype: 'petty_cash' }, side: 'debit' });
    });

    it('a role mapped onto a row that would be re-typed is refused by name, judged by the account\'s real type', async () => {
      await addAccount(h.fx, { code: 'IRT-R1', type: 'asset', level: 3 });
      const out = await inTx(h.fx, async () => {
        const session = await createSession(h.fx.companyId, 'sage', h.fx.userId);
        return importChartOfAccounts(h.fx.companyId, session.id, [coaRow('IRT-R1', 'expense', 'Admin')], { admin_expense: 'IRT-R1' } as never);
      });
      expect({ imported: out.imported, refusal: out.errors.map((e) => ({ field: e.field, typed: /type 'expense'.*got 'asset'/.test(e.message) })),
        r1: await account('IRT-R1') }).toEqual({
        imported: 0, refusal: [{ field: 'systemAccountMap.admin_expense', typed: true }],
        r1: { account_type: 'asset', account_name: `IRT-R1 name ${h.fx.tag}`, account_subtype: null },
      });
    });
  });

  describe('migration re-run', () => {
    it('a row that re-types an account this source imported is refused and named; a same-type row still updates', async () => {
      await addAccount(h.fx, { code: 'IRT-X1', type: 'asset', level: 1 });
      await addAccount(h.fx, { code: 'IRT-X2', type: 'asset', level: 1 });
      await sql`UPDATE gl_accounts SET imported_from = 'xero'
                 WHERE company_id = ${h.fx.companyId}::UUID AND account_code IN ('IRT-X1', 'IRT-X2')`;
      const out = await rerun([xeroRow('IRT-X1', 'expense', 'Xero expense'), xeroRow('IRT-X2', 'asset', 'Xero asset')]);
      expect({
        imported: out.accountsImported,
        named: out.errors.filter((e) => e.includes('IRT-X1')).map((e) => /is an existing asset account; the file makes it expense.*chart of accounts/.test(e)),
        x1: await account('IRT-X1'), x2: (await account('IRT-X2'))!.account_name,
      }).toEqual({
        imported: 1, named: [true],
        x1: { account_type: 'asset', account_name: `IRT-X1 name ${h.fx.tag}`, account_subtype: null },
        x2: 'Xero asset',
      });
    });

    it('a refused row with an opening balance refuses the opening balances whole, naming it; nothing posts', async () => {
      await addAccount(h.fx, { code: 'IRT-X4', type: 'asset', level: 3 });
      await addAccount(h.fx, { code: 'IRT-X5', type: 'liability', level: 3 });
      await sql`UPDATE gl_accounts SET imported_from = 'xero'
                 WHERE company_id = ${h.fx.companyId}::UUID AND account_code IN ('IRT-X4', 'IRT-X5')`;
      const out = await rerun([{ ...xeroRow('IRT-X4', 'liability', 'Was an asset'), openingBalance: 1000 },
        { ...xeroRow('IRT-X5', 'liability', 'Payable'), openingBalance: -1000 }]);
      const lines = Number(((await sql`
        SELECT COUNT(*)::INT AS n FROM gl_journal_lines jl JOIN gl_accounts a ON a.id = jl.gl_account_id
         WHERE a.company_id = ${h.fx.companyId}::UUID AND a.account_code IN ('IRT-X4', 'IRT-X5')`) as Row[])[0]!.n);
      expect({ set: out.openingBalancesSet, lines,
        named: out.errors.some((e) => /^Opening balances: .*IRT-X4 Was an asset \(asset here, liability in the file\)/.test(e)),
        x4: (await account('IRT-X4'))!.account_type }).toEqual({ set: 0, lines: 0, named: true, x4: 'asset' });
    });

    it('a system account the source imported keeps its type and takes the name (not refused)', async () => {
      await addAccount(h.fx, { code: 'IRT-X6', type: 'asset', level: 3, subtype: 'petty_cash', system: true });
      await sql`UPDATE gl_accounts SET imported_from = 'xero' WHERE company_id = ${h.fx.companyId}::UUID AND account_code = 'IRT-X6'`;
      const out = await rerun([xeroRow('IRT-X6', 'expense', 'System via xero')]);
      expect({ imported: out.accountsImported, x6: await account('IRT-X6') })
        .toEqual({ imported: 1, x6: { account_type: 'asset', account_name: 'System via xero', account_subtype: 'petty_cash' } });
    });

    it('a row whose code comes from its name is refused the same way', async () => {
      await addAccount(h.fx, { code: 'IRT Named', type: 'asset', level: 3 });
      await sql`UPDATE gl_accounts SET imported_from = 'xero' WHERE company_id = ${h.fx.companyId}::UUID AND account_code = 'IRT Named'`;
      const out = await rerun([xeroRow('', 'expense', 'IRT Named')]);
      expect({ imported: out.accountsImported, named: out.errors.some((e) => /IRT Named": is an existing asset account/.test(e)),
        t: (await account('IRT Named'))!.account_type }).toEqual({ imported: 0, named: true, t: 'asset' });
    });

    it('an account another source owns keeps the existing "not owned" report', async () => {
      await addAccount(h.fx, { code: 'IRT-X3', type: 'asset', level: 1 });
      const out = await rerun([xeroRow('IRT-X3', 'expense', 'Not mine')]);
      expect({ imported: out.accountsImported, notOwned: out.errors.some((e) => e.includes('IRT-X3') && e.includes('does not own')),
        x3: (await account('IRT-X3'))!.account_type }).toEqual({ imported: 0, notOwned: true, x3: 'asset' });
    });
  });
});
