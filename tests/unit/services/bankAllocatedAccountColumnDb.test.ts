/**
 * The Bank Transactions "Account" column names the GL account, however the row
 * was allocated — proven against a real Postgres.
 *
 * The defect: `bank_transactions.allocated_entity_name` carried two different
 * kinds of value. Allocating directly stored "<code> <name>"; a categorisation
 * rule stored the RULE's name. Two restaurant purchases posted to Staff Welfare
 * showed as "ROMANS PIZZA" and "HENRIS SOMERSET", so the screen a bookkeeper
 * uses to check where things went could not answer that for rule-allocated rows
 * — which are the majority of this ledger.
 *
 * This test allocates one transaction by rule and one directly, then asserts
 * BOTH report the same account code and name, and that only the rule-allocated
 * one carries a rule name — in its own field.
 *
 * Mutation check: point `allocEntityName` in bankRuleAutoPostLine back at
 * `ruleName`, or drop the lateral join from TX_SELECT, and the rule-allocated
 * assertions go red.
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
import { applyRules } from '@/modules/accounting/services/bank/bankRulesMatchingService';
import { getBankTransactions, matchTransaction } from '@/modules/accounting/services/bank/bankTransactionQueryService';

type Ctx = Parameters<typeof als.run>[0];

const USER_ID = '00000000-0000-0000-0000-0000000000aa';
const RULE_NAME = 'ZZ TEST RULE — ROMANS PIZZA';
const RULE_TX_DESC = 'ZZTESTROMANSPIZZA purchase';
const DIRECT_TX_DESC = 'ZZTESTDIRECT purchase';

function ctxFor(client: PoolClient, companyId: string): Ctx {
  return { client, userId: USER_ID, companyId, claims: {} } as unknown as Ctx;
}

async function insertTx(client: PoolClient, f: BankFixture, description: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
     VALUES ($1, $2, CURRENT_DATE, -474.60, $3, 'imported') RETURNING id`,
    [f.companyId, f.bankAccountId, description],
  );
  return rows[0]!.id;
}

describe('allocated Account column resolves to the GL account, not the rule name', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('names the account for a rule-allocated row and a directly-allocated row alike', async (ctx) => {
    assertNotProductionDb();
    const pool = getPoolForTests();
    const client = await pool.connect();
    try {
      const fixture = await findBankFixture(client);
      if (!fixture) {
        ctx.skip('no company with both a bank and an expense GL account');
        return;
      }

      // Everything below happens inside one transaction that is rolled back, so
      // the ledger this runs against is left exactly as it was found.
      await client.query('BEGIN');

      const { rows: acctRows } = await client.query<{ account_code: string; account_name: string }>(
        'SELECT account_code, account_name FROM gl_accounts WHERE id = $1',
        [fixture.expenseAccountId],
      );
      const expected = `${acctRows[0]!.account_code} ${acctRows[0]!.account_name}`;

      const { rows: ruleRows } = await client.query<{ id: string }>(
        `INSERT INTO bank_categorisation_rules
           (company_id, rule_name, match_field, match_type, match_pattern, gl_account_id,
            priority, is_active, auto_create_entry, vat_code)
         VALUES ($1, $2, 'description', 'contains', 'ZZTESTROMANSPIZZA', $3, -1000, true, true, 'none')
         RETURNING id`,
        [fixture.companyId, RULE_NAME, fixture.expenseAccountId],
      );
      const ruleId = ruleRows[0]!.id;

      const ruleTxId = await insertTx(client, fixture, RULE_TX_DESC);
      const directTxId = await insertTx(client, fixture, DIRECT_TX_DESC);

      const page = await als.run(ctxFor(client, fixture.companyId), async () => {
        const applied = await applyRules(fixture.companyId, fixture.bankAccountId, USER_ID, [ruleId]);
        expect(applied.applied).toBe(1);
        await allocateTransaction(
          fixture.companyId, directTxId, fixture.expenseAccountId, USER_ID, 'direct allocation',
        );
        return getBankTransactions(fixture.companyId, { bankAccountId: fixture.bankAccountId, limit: 100 });
      });

      const byRule = page.transactions.find(t => t.id === ruleTxId);
      const direct = page.transactions.find(t => t.id === directTxId);
      expect(byRule, 'rule-allocated transaction missing from the page').toBeDefined();
      expect(direct, 'directly-allocated transaction missing from the page').toBeDefined();

      // 1. Both name the account the journal actually hit, in the same form.
      expect(byRule!.allocatedEntityName).toBe(expected);
      expect(direct!.allocatedEntityName).toBe(expected);
      expect(byRule!.allocatedAccountCode).toBe(acctRows[0]!.account_code);
      expect(byRule!.allocatedAccountName).toBe(acctRows[0]!.account_name);
      expect(direct!.allocatedAccountCode).toBe(acctRows[0]!.account_code);
      expect(direct!.allocatedAccountName).toBe(acctRows[0]!.account_name);

      // 2. The rule name is still available — in its own field, never the account.
      expect(byRule!.allocationRuleName).toBe(RULE_NAME);
      expect(byRule!.allocationRuleId).toBe(ruleId);
      expect(direct!.allocationRuleName).toBeUndefined();
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  // The account column must stay SILENT when it cannot know the answer. `matchTransaction`
  // (the `journal_line` branch of bank-match-confirm) writes whatever line the user picked
  // out of `fetchJournalLineCandidates`, which ranks EVERY posted line in the company by
  // amount and applies no account filter. Matched against a non-bank line, "the sibling of
  // the matched line" is not the destination — it is just the other half of somebody else's
  // journal. Naming it would be the same defect this change exists to remove, only louder.
  //
  // Mutation check: drop `AND bl.gl_account_id = bt.bank_account_id` from
  // ALLOCATED_ACCOUNT_LATERAL and this goes red with the unrelated account's label.
  it.skipIf(!reachable)('reports no account when the matched line is not this transaction\'s bank leg', async (ctx) => {
    assertNotProductionDb();
    const pool = getPoolForTests();
    const client = await pool.connect();
    try {
      const fixture = await findBankFixture(client);
      if (!fixture) {
        ctx.skip('no company with both a bank and an expense GL account');
        return;
      }
      await client.query('BEGIN');

      // A posted journal that has nothing to do with any bank account: expense vs payables.
      const { rows: payableRows } = await client.query<{ id: string }>(
        `SELECT id FROM gl_accounts
         WHERE company_id = $1 AND is_active AND id <> $2 AND id <> $3
         ORDER BY account_code LIMIT 1`,
        [fixture.companyId, fixture.expenseAccountId, fixture.bankAccountId],
      );
      if (!payableRows[0]) {
        ctx.skip('no third GL account to build an unrelated journal from');
        return;
      }
      const { rows: jeRows } = await client.query<{ id: string }>(
        `INSERT INTO gl_journal_entries (company_id, entry_date, description, status, source, created_by)
         VALUES ($1, CURRENT_DATE, 'ZZTEST unrelated journal', 'posted', 'manual', $2) RETURNING id`,
        [fixture.companyId, USER_ID],
      );
      const jeId = jeRows[0]!.id;
      const { rows: lineRows } = await client.query<{ id: string }>(
        `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
         VALUES ($1, $2, $3, 474.60, 0, 'ZZTEST expense leg'),
                ($1, $2, $4, 0, 474.60, 'ZZTEST payable leg')
         RETURNING id`,
        [fixture.companyId, jeId, fixture.expenseAccountId, payableRows[0].id],
      );
      const expenseLegId = lineRows[0]!.id;

      const txId = await insertTx(client, fixture, 'ZZTESTJOURNALLINEMATCH purchase');

      const page = await als.run(ctxFor(client, fixture.companyId), async () => {
        // Matching to the EXPENSE leg — not the bank leg. This is what the UI's
        // journal_line candidate list makes possible.
        await matchTransaction(fixture.companyId, txId, expenseLegId);
        return getBankTransactions(fixture.companyId, { bankAccountId: fixture.bankAccountId, limit: 100 });
      });

      const row = page.transactions.find(t => t.id === txId);
      expect(row, 'journal-line-matched transaction missing from the page').toBeDefined();
      expect(row!.matchedJournalLineId).toBe(expenseLegId);
      // The payable leg is the sibling. It must NOT be presented as the account.
      expect(row!.allocatedEntityName).toBeUndefined();
      expect(row!.allocatedAccountCode).toBeUndefined();
      expect(row!.allocatedAccountName).toBeUndefined();
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
