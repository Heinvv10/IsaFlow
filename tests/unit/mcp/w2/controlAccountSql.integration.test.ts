/**
 * The control-account SQL against isaflow_dev. BEGIN … ROLLBACK; DB-gated.
 *
 * The unit suite mocks `sql`, so it cannot see the query at all — dropping the
 * posting arm from the SQL leaves every unit test green. That arm is the whole
 * point of the resolver (it is what finds Brightsphere's account 1120, subtype
 * NULL, carrying a R10,000 receipt), so it needs a test that actually runs it.
 */
import { describe, it, expect, vi } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../../helpers/dbReachable';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { getPoolForTests, sql } from '@/lib/neon';
import { getControlAccountBalances } from '@/modules/accounting/services/gl/controlAccountService';

type AlsCtx = Parameters<typeof als.run>[0];

/** gl_journal_entries.created_by is uuid-typed here, unlike users.id (varchar(255)). */
const CREATOR = '00000000-0000-4000-8000-0000000000w2'.replace('w2', '01');

async function inTx(run: (companyId: string) => Promise<void>) {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run(
      { client, userId: 'test', companyId: 'bootstrap', claims: {} } as unknown as AlsCtx,
      async () => {
        const rows = (await sql`
          SELECT id FROM companies WHERE name = 'Brightsphere Technologies (Pty) Ltd' LIMIT 1
        `) as Array<{ id: string }>;
        const companyId = rows[0]?.id;
        if (!companyId) throw new Error('no Brightsphere company in isaflow_dev');
        await run(companyId);
      },
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('control-account resolution — real database', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)(
    'finds a NULL-subtype account by its postings, and a deactivated one by its subtype',
    async () => {
      await inTx(async (companyId) => {
        // A receivable-typed account that is DEACTIVATED and carries a balance:
        // the row a `WHERE is_active` filter would silently drop.
        const [dormant] = (await sql`
          INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
                                   account_subtype, normal_balance, is_active, level)
          VALUES (${companyId}::UUID, 'ZZ-DORMANT', 'Dormant Debtors', 'asset',
                  'receivable', 'debit', false, 3)
          RETURNING id
        `) as Array<{ id: string }>;

        // An UNTYPED asset account that a customer receipt posts its control
        // leg to. Nothing about its subtype says "receivable".
        const [untyped] = (await sql`
          INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
                                   account_subtype, normal_balance, is_active, level)
          VALUES (${companyId}::UUID, 'ZZ-UNTYPED', 'Untyped Receivable', 'asset',
                  NULL, 'debit', true, 3)
          RETURNING id
        `) as Array<{ id: string }>;

        const [bank] = (await sql`
          SELECT id FROM gl_accounts
          WHERE company_id = ${companyId}::UUID AND account_type = 'asset'
            AND account_subtype = 'bank' LIMIT 1
        `) as Array<{ id: string }>;
        expect(bank).toBeDefined();

        const [customer] = (await sql`
          SELECT id FROM customers WHERE company_id = ${companyId}::UUID LIMIT 1
        `) as Array<{ id: string }>;
        expect(customer).toBeDefined();

        const [period] = (await sql`
          SELECT id FROM fiscal_periods WHERE company_id = ${companyId}::UUID
          ORDER BY start_date DESC LIMIT 1
        `) as Array<{ id: string }>;

        const [je] = (await sql`
          INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description,
                                          status, source, fiscal_period_id, created_by)
          VALUES (${companyId}::UUID, 'ZZ-JE-CTRL', '2026-01-15', 'W2 control probe',
                  'posted', 'auto_payment', ${period?.id ?? null}::UUID, ${CREATOR}::UUID)
          RETURNING id
        `) as Array<{ id: string }>;

        await sql`
          INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
          VALUES (${companyId}::UUID, ${je!.id}::UUID, ${bank!.id}::UUID, 4321, 0),
                 (${companyId}::UUID, ${je!.id}::UUID, ${untyped!.id}::UUID, 0, 4321)
        `;

        // Seeding a payment ROW is what makes the journal a subledger document.
        await sql`
          INSERT INTO customer_payments (company_id, client_id, payment_date, total_amount,
                                         status, gl_journal_entry_id, created_by, payment_number)
          VALUES (${companyId}::UUID, ${customer!.id}::UUID, '2026-01-15', 4321,
                  'confirmed', ${je!.id}::UUID, ${CREATOR}::UUID, 'ZZ-CP-CTRL')
        `;

        const accounts = await getControlAccountBalances(companyId, 'ar', '2026-12-31');
        const byCode = new Map(accounts.map((a) => [a.accountCode, a]));

        // The posting arm: found despite a NULL subtype, carrying the credit.
        expect(byCode.get('ZZ-UNTYPED')).toMatchObject({ foundBy: 'posting', balance: -4321 });
        // The subtype arm: a deactivated account is still returned.
        expect(byCode.get('ZZ-DORMANT')).toMatchObject({ foundBy: 'subtype', isActive: false });
        expect(byCode.get('ZZ-DORMANT')!.accountId).toBe(dormant!.id);
        // The BANK leg of the same journal must NOT be mistaken for AR control.
        expect(accounts.some((a) => a.accountId === bank!.id)).toBe(false);
      });
    },
  );

  it.skipIf(!reachable)(
    'refuses an untyped account that supplier invoices DEBIT — it is the tax leg, not the payable',
    async () => {
      // Found on production. `SYS-9 VAT Payable` carries a NULL subtype, is
      // typed `liability`, and is touched by 356 Velocity supplier-invoice
      // journals — so `excludeSubtypes`, which matches on `vat_output`, could
      // not exclude it and the posting arm adopted it as an AP control account.
      // It brought −R4,917,814.24 into the control balance, and the
      // reconciliation then "explained" exactly +R4,917,814.24 with a
      // 356-document `document_not_on_control_account` item. The arithmetic
      // closed on an artefact of the resolver.
      //
      // The rule that catches it uses no account name: a payable control
      // account is NET CREDITED by the bills that create it. An account that
      // supplier invoices net-DEBIT is the input-VAT or expense side. The
      // direction test only applies where there IS invoice movement, so the
      // NULL-subtype account found only by a PAYMENT — the R10,000 Brightsphere
      // case above — is still kept.
      await inTx(async (companyId) => {
        const [taxish] = (await sql`
          INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
                                   account_subtype, normal_balance, is_active, level)
          VALUES (${companyId}::UUID, 'ZZ-TAXISH', 'Untyped Tax Leg', 'liability',
                  NULL, 'credit', true, 3)
          RETURNING id
        `) as Array<{ id: string }>;

        const [payable] = (await sql`
          SELECT id FROM gl_accounts WHERE company_id = ${companyId}::UUID
            AND account_type = 'liability' AND account_subtype = 'payable' LIMIT 1
        `) as Array<{ id: string }>;
        expect(payable).toBeDefined();

        const [expense] = (await sql`
          SELECT id FROM gl_accounts WHERE company_id = ${companyId}::UUID
            AND account_type = 'expense' LIMIT 1
        `) as Array<{ id: string }>;
        expect(expense).toBeDefined();

        const [supplier] = (await sql`
          SELECT id FROM suppliers WHERE company_id = ${companyId}::UUID LIMIT 1
        `) as Array<{ id: string }>;
        expect(supplier).toBeDefined();

        const [period] = (await sql`
          SELECT id FROM fiscal_periods WHERE company_id = ${companyId}::UUID
          ORDER BY start_date DESC LIMIT 1
        `) as Array<{ id: string }>;

        const [je] = (await sql`
          INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description,
                                          status, source, fiscal_period_id, created_by)
          VALUES (${companyId}::UUID, 'ZZ-JE-APCTRL', '2026-01-20', 'W2 AP control probe',
                  'posted', 'auto_supplier_invoice', ${period?.id ?? null}::UUID, ${CREATOR}::UUID)
          RETURNING id
        `) as Array<{ id: string }>;

        // A bill: DR expense 850, DR the untyped tax leg 150, CR payable 1000.
        await sql`
          INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
          VALUES (${companyId}::UUID, ${je!.id}::UUID, ${expense!.id}::UUID, 850, 0),
                 (${companyId}::UUID, ${je!.id}::UUID, ${taxish!.id}::UUID, 150, 0),
                 (${companyId}::UUID, ${je!.id}::UUID, ${payable!.id}::UUID, 0, 1000)
        `;

        await sql`
          INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date,
                                         due_date, subtotal, total_amount, status,
                                         gl_journal_entry_id, created_by)
          VALUES (${companyId}::UUID, ${supplier!.id}::UUID, 'ZZ-BILL-APCTRL', '2026-01-20',
                  '2026-02-20', 850, 1000, 'approved', ${je!.id}::UUID, ${CREATOR}::UUID)
        `;

        const accounts = await getControlAccountBalances(companyId, 'ap', '2026-12-31');
        expect(accounts.some((a) => a.accountId === taxish!.id)).toBe(false);
        // ...and the real payable account is still there, so the exclusion is
        // not simply refusing everything the probe found.
        expect(accounts.some((a) => a.accountId === payable!.id)).toBe(true);
      });
    },
  );
});
