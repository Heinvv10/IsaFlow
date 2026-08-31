/**
 * The bank screen's VAT column must say what the journal actually did.
 *
 * The defect: the column rendered `rowSelections[tx.id]?.vatCode`, seeded from
 * `bank_transactions.suggested_vat_code` — which the rule auto-post path NULLs
 * the instant it allocates. Every rule-posted row therefore fell through to
 * 'none' and read "No VAT" while its journal had debited VAT Input at 15%.
 * R43,008.01 of entertainment input tax sat behind rows a reviewer read as
 * carrying none.
 *
 * Asserting the journal alone would NOT have caught it — the journals were
 * correct arithmetic, wrongly summarised. So every case here asserts BOTH:
 * the journal lines that exist, and what the read path the screen uses reports.
 * Drop POSTED_VAT_LATERAL from TX_SELECT and case 2 goes red; drop the
 * resolveVatCodeForAccount call from allocateTransaction and case 3 goes red.
 *
 * This test WRITES, so it refuses to run against the production database.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import { assertNotProductionDb, findBankFixture, type BankFixture } from '../helpers/bankDbFixture';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import { autoPostRuleLine } from '@/modules/accounting/services/bank/bankRuleAutoPostLine';
import { findVatAllocationMismatches } from '@/modules/accounting/services/reports/vatAllocationMismatchService';

const USER_ID = '00000000-0000-0000-0000-0000000000aa';
/** R1,150.00 gross → R1,000.00 net + R150.00 VAT at 15%, no rounding noise. */
const GROSS = 1150.0;

type Ctx = Parameters<typeof als.run>[0];
const ctxFor = (client: PoolClient, companyId: string): Ctx =>
  ({ client, userId: USER_ID, companyId, claims: {} } as unknown as Ctx);

interface Posted {
  /** Sum of every line hitting a vat_input/vat_output account. */
  vatLineTotal: number;
  /** What the read path behind the screen reports for this row. */
  screenVatCode: string | undefined;
  screenVatAmount: number | undefined;
}

async function allocateAndRead(
  client: PoolClient,
  fixture: BankFixture,
  txId: string,
  accountId: string,
  vatCode: string,
): Promise<Posted> {
  await als.run(ctxFor(client, fixture.companyId), () =>
    allocateTransaction(
      fixture.companyId, txId, accountId, USER_ID, 'vat display test',
      'account', undefined, vatCode,
    ),
  );

  const { rows } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(ABS(COALESCE(jl.debit,0)) + ABS(COALESCE(jl.credit,0))), 0) AS total
       FROM bank_transactions bt
       JOIN gl_journal_lines mjl ON mjl.id = bt.matched_journal_line_id
       JOIN gl_journal_lines jl  ON jl.journal_entry_id = mjl.journal_entry_id
       JOIN gl_accounts va       ON va.id = jl.gl_account_id
      WHERE bt.id = $1 AND va.account_subtype IN ('vat_input','vat_output')`,
    [txId],
  );

  const page = await als.run(ctxFor(client, fixture.companyId), () =>
    getBankTransactions(fixture.companyId, { bankAccountId: fixture.bankAccountId, limit: 200 }),
  );
  const row = page.transactions.find((t) => t.id === txId);
  expect(row, 'allocated row must come back from the screen read path').toBeTruthy();

  return {
    vatLineTotal: Number(rows[0]!.total),
    screenVatCode: row!.postedVatCode,
    screenVatAmount: row!.postedVatAmount,
  };
}

describe('bank screen VAT column agrees with the posted journal', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('none claims nothing, standard claims 15%, and a denied account claims nothing', async (ctx) => {
    assertNotProductionDb();
    const pool = getPoolForTests();
    const client = await pool.connect();

    // Everything below runs inside ONE transaction that is always rolled back:
    // the fixtures never reach a committed state, so no posted journal or test
    // GL account is left behind for a later run (or a human) to trip over.
    await client.query('BEGIN');
    try {
      const fixture = await findBankFixture(client);
      if (!fixture) {
        ctx.skip('no company with both a bank and an expense GL account');
        return;
      }

      const insert = async (): Promise<string> => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO bank_transactions
             (company_id, bank_account_id, transaction_date, amount, description, status)
           VALUES ($1, $2, CURRENT_DATE, $3, 'vat display test', 'imported') RETURNING id`,
          [fixture.companyId, fixture.bankAccountId, -GROSS],
        );
        return rows[0]!.id;
      };

      // 1. vat_code 'none' — no VAT line, and the screen says so.
      const none = await allocateAndRead(
        client, fixture, await insert(), fixture.expenseAccountId, 'none');
      expect(none.vatLineTotal).toBe(0);
      expect(none.screenVatCode).toBe('none');

      // 2. vat_code 'standard' — a VAT line exists, and the screen agrees.
      //    This is the assertion the shipped code failed: the journal claimed
      //    R150.00 while the column read "No VAT".
      const standard = await allocateAndRead(
        client, fixture, await insert(), fixture.expenseAccountId, 'standard');
      expect(standard.vatLineTotal).toBeCloseTo(150.0, 2);
      expect(standard.screenVatCode).toBe('standard');
      expect(standard.screenVatAmount).toBeCloseTo(150.0, 2);

      // 3. s17(2)(a) is ADVISORY on the attended path. The screen warns, but the
      //    proviso in s17(2)(a)(i) lets a vendor who continuously supplies
      //    entertainment claim the tax, and only the user knows whether that is
      //    them — so a deliberate 'standard' here MUST still post, and the
      //    column must report what posted. Coercing the user's choice would be
      //    the same "screen disagrees with the journal" defect in reverse.
      const { rows: denied } = await client.query<{ id: string }>(
        `INSERT INTO gl_accounts
           (company_id, account_code, account_name, account_type, account_subtype,
            normal_balance, default_vat_code, vat_input_denied, is_active)
         VALUES ($1, $2, 'Staff Welfare (test)', 'expense', 'operating_expense',
                 'debit', 'none', true, true)
         RETURNING id`,
        [fixture.companyId, `ZZTEST-${Date.now()}`],
      );
      const deniedAccountId = denied[0]!.id;

      const entertainment = await allocateAndRead(
        client, fixture, await insert(), deniedAccountId, 'standard');
      expect(entertainment.vatLineTotal,
        'the attended path must honour a deliberate claim').toBeCloseTo(150.0, 2);
      expect(entertainment.screenVatCode).toBe('standard');

      // 3b. A denial bites on 'standard' ONLY. s17(2)(a) denies input tax; it
      //     does not un-zero-rate a supply, and gl_journal_lines.vat_type feeds
      //     VAT201 and the exceptions reports. Coercing 'zero_rated' to 'none'
      //     would strip that classification off the ledger with nothing to say so.
      const zeroRated = await allocateAndRead(
        client, fixture, await insert(), deniedAccountId, 'zero_rated');
      expect(zeroRated.vatLineTotal, 'zero-rated claims no input tax').toBe(0);
      expect(zeroRated.screenVatCode, 'zero-rated survives the denial').toBe('zero_rated');

      // 4. The RULE auto-post path — UNATTENDED, and so the one place the flag
      //    actually overrides. Nobody sees a warning on a schedule, so a rule
      //    left on vat_code='standard' against an entertainment account posts
      //    GROSS and reports it, rather than claiming on every future charge.
      //    This is deliberately the OPPOSITE of case 3.
      const ruleTxId = await insert();
      const { rows: ruleTxRows } = await client.query(
        'SELECT * FROM bank_transactions WHERE id = $1', [ruleTxId]);
      const outcome = await als.run(ctxFor(client, fixture.companyId), () =>
        autoPostRuleLine({
          companyId: fixture.companyId,
          userId: USER_ID,
          tx: ruleTxRows[0] as Record<string, unknown>,
          rule: { vat_code: 'standard' },
          ruleName: 'Staff Welfare (test) rule',
          allocType: 'account',
          ruleGlAccountId: deniedAccountId,
          bankGlAccountId: fixture.bankAccountId,
          apAccountId: null,
          arAccountId: null,
          supplierName: null,
          customerName: null,
        }),
      );
      expect(outcome.kind, 'rule line must post, not skip').toBe('posted');
      expect((outcome as { vatDenied: boolean }).vatDenied,
        'the coercion must be reported, not silent').toBe(true);

      const { rows: ruleVat } = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(ABS(COALESCE(jl.debit,0)) + ABS(COALESCE(jl.credit,0))), 0) AS total
           FROM gl_journal_lines jl
           JOIN gl_accounts va ON va.id = jl.gl_account_id
          WHERE jl.journal_entry_id = $1
            AND va.account_subtype IN ('vat_input','vat_output')`,
        [(outcome as { journalEntryId: string }).journalEntryId],
      );
      expect(Number(ruleVat[0]!.total),
        'rule auto-post must not claim denied input tax').toBe(0);

      // 4b. The same line WITH the batched default the sweep passes in. Case 4
      //     omits it and exercises the in-line lookup; this one exercises the
      //     path production actually takes. Both must reach the same answer —
      //     the batching optimisation must not be a way to switch the guard off.
      const batchedTxId = await insert();
      const { rows: batchedTxRows } = await client.query(
        'SELECT * FROM bank_transactions WHERE id = $1', [batchedTxId]);
      const batchedOutcome = await als.run(ctxFor(client, fixture.companyId), () =>
        autoPostRuleLine({
          companyId: fixture.companyId,
          userId: USER_ID,
          tx: batchedTxRows[0] as Record<string, unknown>,
          rule: { vat_code: 'standard' },
          ruleName: 'Staff Welfare (test) rule, batched',
          allocType: 'account',
          ruleGlAccountId: deniedAccountId,
          ruleGlAccountVatDenied: true,
          bankGlAccountId: fixture.bankAccountId,
          apAccountId: null,
          arAccountId: null,
          supplierName: null,
          customerName: null,
        }),
      );
      expect(batchedOutcome.kind).toBe('posted');
      const { rows: batchedVat } = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(ABS(COALESCE(jl.debit, 0)) + ABS(COALESCE(jl.credit, 0))), 0) AS total
           FROM gl_journal_lines jl
           JOIN gl_accounts va ON va.id = jl.gl_account_id
          WHERE jl.journal_entry_id = $1
            AND va.account_subtype IN ('vat_input','vat_output')`,
        [(batchedOutcome as { journalEntryId: string }).journalEntryId],
      );
      expect(Number(batchedVat[0]!.total),
        'the batched default must deny exactly as the in-line lookup does').toBe(0);

      // 5. The retrospective sweep must SEE the disagreement the screen used to
      //    hide. Case 2 posted 15% while its suggestion column says nothing, so
      //    it is exactly the shape of the 1,594 historical rows on Brighttech.
      const sweep = await als.run(ctxFor(client, fixture.companyId), () =>
        findVatAllocationMismatches(fixture.companyId, { limit: 5000 }),
      );
      const flagged = sweep.rows.find((r) => r.journalVatCode === 'standard'
        && r.displayedVatCode === 'none' && Math.abs(r.amount) === GROSS);
      expect(flagged, 'sweep must list the row whose journal claimed VAT the screen did not show')
        .toBeTruthy();
      expect(flagged!.postedVatAmount).toBeCloseTo(150.0, 2);

      // 6. The other arm: input tax already claimed against an account that
      //    denies it — the 478 historical journals. Reproduced by claiming VAT
      //    first and marking the account denied afterwards, which is exactly
      //    the order history happened in. The account is given a NULL
      //    account_subtype on purpose: 49 of 284 real expense accounts have one,
      //    and a bare `NOT IN` yields NULL there, which a FILTER drops — the
      //    report could then neither raise the flag nor name the account.
      const { rows: nullSub } = await client.query<{ id: string }>(
        `INSERT INTO gl_accounts
           (company_id, account_code, account_name, account_type, account_subtype,
            normal_balance, is_active)
         VALUES ($1, $2, 'Entertainment (test, null subtype)', 'expense', NULL,
                 'debit', true)
         RETURNING id`,
        [fixture.companyId, `ZZNULL-${Date.now()}`],
      );
      const nullSubAccountId = nullSub[0]!.id;

      const claimed = await allocateAndRead(
        client, fixture, await insert(), nullSubAccountId, 'standard');
      expect(claimed.vatLineTotal, 'claims VAT while the account still allows it')
        .toBeCloseTo(150.0, 2);

      await client.query(
        `UPDATE gl_accounts SET vat_input_denied = true WHERE id = $1`, [nullSubAccountId]);

      const sweep2 = await als.run(ctxFor(client, fixture.companyId), () =>
        findVatAllocationMismatches(fixture.companyId, { limit: 5000 }),
      );
      const denialHit = sweep2.rows.find((r) => r.accountName === 'Entertainment (test, null subtype)');
      expect(denialHit, 'sweep must find input tax claimed on a denied account').toBeTruthy();
      expect(denialHit!.reasons).toContain('input_vat_on_denied_account');
      expect(denialHit!.postedVatAmount).toBeCloseTo(150.0, 2);
    } finally {
      // release(true) DESTROYS the connection. A rollback that failed leaves an
      // aborted or still-open transaction on it, and handing that back to the
      // pool poisons whoever borrows it next — the same shape as #282.
      let rollbackFailed = false;
      await client.query('ROLLBACK').catch(() => { rollbackFailed = true; });
      client.release(rollbackFailed);
    }
  }, 60_000);
});
