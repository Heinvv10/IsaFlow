/**
 * allocate_bank_transaction BY REFERENCE against a REAL ledger.
 *
 * Every other test of the reference path mocks
 * `findBankTransactionsByReference`, so all of them passed throughout the
 * production defect: the lookup matched `btrim(bank_reference)` only, and
 * production has 9,824 rows with `reference` set and ZERO with
 * `bank_reference`. The pilot's `bank_reference: "20220402-0011"` came back
 * NOT_FOUND for a transaction that allocated fine by transaction_id.
 *
 * Only real SQL against a real column can see that, so this test seeds the
 * PRODUCTION SHAPE — `reference` set, `bank_reference` NULL — and posts through
 * the real tool handler and the real `allocateTransaction`. A twin row
 * allocated by transaction_id is the control: the two journals must be
 * identical apart from their ids.
 *
 * The whole test runs inside BEGIN … ROLLBACK on an ALS-bound client, exactly
 * as withAuth would, so nothing survives the run.
 *
 * DB-gated: skips (never fails) when no DB is reachable — see dbReachable.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests, sql } from '@/lib/neon';
import { allocateBankTransactionTool } from '@/lib/mcp/tools/writeBankAllocate';
import { findBankTransactionsByReference } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import type { McpToolContext } from '@/lib/mcp/types';

type AlsCtx = Parameters<typeof als.run>[0];
function alsCtx(client: unknown, companyId: string, userId: string): AlsCtx {
  return { client, userId, companyId, claims: {} } as unknown as AlsCtx;
}

interface Fixture {
  companyId: string;
  userId: string;
  contraAccountId: string;
  bankAccountId: string;
}

/** A company that already has a bank account and an expense account to book to. */
async function loadFixtureIds(): Promise<Fixture> {
  const rows = (await sql`
    SELECT bank.company_id, bank.id AS bank_account_id, expense.id AS contra_account_id
    FROM gl_accounts bank
    JOIN gl_accounts expense
      ON expense.company_id = bank.company_id AND expense.account_type = 'expense'
    WHERE bank.account_subtype = 'bank'
    ORDER BY bank.company_id, bank.account_code, expense.account_code
    LIMIT 1
  `) as Array<{ company_id: string; bank_account_id: string; contra_account_id: string }>;
  const row = rows[0];
  if (!row) throw new Error('no company in isaflow_dev has both a bank and an expense account');

  const users = (await sql`
    SELECT created_by FROM gl_journal_entries
    WHERE company_id = ${row.company_id}::uuid AND created_by IS NOT NULL
    LIMIT 1
  `) as Array<{ created_by: string }>;
  const userId = users[0]?.created_by;
  if (!userId) throw new Error('no existing journal author to borrow for the fixture');

  return {
    companyId: row.company_id,
    userId,
    contraAccountId: row.contra_account_id,
    bankAccountId: row.bank_account_id,
  };
}

/**
 * One transaction in the production shape: the statement reference in
 * `reference`, `bank_reference` explicitly NULL.
 */
async function seedTx(
  f: Fixture,
  reference: string | null,
  description: string,
): Promise<string> {
  const rows = (await sql`
    INSERT INTO bank_transactions (
      company_id, bank_account_id, transaction_date, amount, description,
      reference, bank_reference, status
    ) VALUES (
      ${f.companyId}::uuid, ${f.bankAccountId}::uuid, '2026-08-03'::date,
      ${-317.25}, ${description}, ${reference}, NULL, 'imported'
    )
    RETURNING id
  `) as Array<{ id: string }>;
  return String(rows[0]!.id);
}

/** The journal's economic content — everything except the ids and timestamps. */
async function journalShape(companyId: string, journalEntryId: string): Promise<{
  status: string;
  postingAgent: string;
  lines: Array<{ gl_account_id: string; debit: string; credit: string }>;
}> {
  const head = (await sql`
    SELECT status, posting_agent FROM gl_journal_entries
    WHERE id = ${journalEntryId}::uuid AND company_id = ${companyId}::uuid
  `) as Array<{ status: string; posting_agent: string }>;
  const lines = (await sql`
    SELECT gl_account_id, debit::text AS debit, credit::text AS credit
    FROM gl_journal_lines
    WHERE journal_entry_id = ${journalEntryId}::uuid
      AND company_id = ${companyId}::uuid
    ORDER BY gl_account_id, debit, credit
  `) as Array<{ gl_account_id: string; debit: string; credit: string }>;
  return { status: String(head[0]!.status), postingAgent: String(head[0]!.posting_agent), lines };
}

function toolCtx(f: Fixture): McpToolContext {
  return {
    companyId: f.companyId,
    userId: f.userId,
    scopes: ['write:bank-tx', 'write:post'],
    tokenJti: 'integration-test',
    oauthAppId: null,
  };
}

/** BEGIN → run → ROLLBACK on an ALS-bound client, exactly as withAuth does. */
async function inRequestTx(run: (f: Fixture) => Promise<void>): Promise<void> {
  assertNotProductionDb('This test INSERTs bank transactions and posts journals.');
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run(alsCtx(client, 'bootstrap', 'bootstrap'), async () => {
      const f = await loadFixtureIds();
      await als.run(alsCtx(client, f.companyId, f.userId), () => run(f));
    });
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

function body(res: { content: Array<{ text: string }>; isError?: boolean }): {
  journal_entry_id: string; transaction_id: string;
} {
  expect(res.isError).toBeUndefined();
  return JSON.parse(res.content[0]!.text) as { journal_entry_id: string; transaction_id: string };
}

describe('allocate_bank_transaction by reference — real ledger', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)(
    'resolves a statement reference stored in `reference` with bank_reference NULL',
    async () => {
      await inRequestTx(async (f) => {
        const ref = `ISAFLOW-REFCOL-${Date.now()}`;
        const byRefTxId = await seedTx(f, ref, 'ISAFLOW REF FIXTURE by-reference');
        const twinTxId = await seedTx(f, null, 'ISAFLOW REF FIXTURE by-id');

        // The lookup itself, against the real column.
        const matches = await findBankTransactionsByReference(f.companyId, ref);
        expect(matches.map((m) => m.id)).toEqual([byRefTxId]);
        expect(matches[0]!.matchedReference).toBe(ref);

        const viaRef = body(await allocateBankTransactionTool.handler(
          {
            bank_reference: ref,
            contra_account_id: f.contraAccountId,
            idempotency_key: 'integration-by-reference',
          },
          toolCtx(f),
        ));
        expect(viaRef.transaction_id).toBe(byRefTxId);

        const viaId = body(await allocateBankTransactionTool.handler(
          {
            transaction_id: twinTxId,
            contra_account_id: f.contraAccountId,
            idempotency_key: 'integration-by-id',
          },
          toolCtx(f),
        ));

        // Same ledger outcome from both routes — the reference resolves to a
        // real row and posts the identical journal.
        const refShape = await journalShape(f.companyId, viaRef.journal_entry_id);
        const idShape = await journalShape(f.companyId, viaId.journal_entry_id);
        expect(refShape.status).toBe('posted');
        expect(refShape.postingAgent).toBe('mcp:allocate_bank_transaction:v1');
        expect(refShape.lines).toHaveLength(2);
        expect(refShape).toEqual(idShape);

        const statuses = (await sql`
          SELECT status FROM bank_transactions
          WHERE id = ANY(${[byRefTxId, twinTxId]}::uuid[])
        `) as Array<{ status: string }>;
        expect(statuses.map((s) => s.status)).toEqual(['allocated', 'allocated']);
      });
    },
  );

  it.skipIf(!reachable)('still resolves a reference carried by bank_reference', async () => {
    await inRequestTx(async (f) => {
      const ref = `ISAFLOW-BANKREFCOL-${Date.now()}`;
      const rows = (await sql`
        INSERT INTO bank_transactions (
          company_id, bank_account_id, transaction_date, amount, description,
          reference, bank_reference, status
        ) VALUES (
          ${f.companyId}::uuid, ${f.bankAccountId}::uuid, '2026-08-03'::date,
          ${-99.5}, 'ISAFLOW REF FIXTURE feed', NULL, ${ref}, 'imported'
        )
        RETURNING id
      `) as Array<{ id: string }>;
      const txId = String(rows[0]!.id);

      const matches = await findBankTransactionsByReference(f.companyId, ref);
      expect(matches.map((m) => m.id)).toEqual([txId]);
      expect(matches[0]!.matchedReference).toBe(ref);

      const res = body(await allocateBankTransactionTool.handler(
        {
          bank_reference: ref,
          contra_account_id: f.contraAccountId,
          idempotency_key: 'integration-by-bankreference',
        },
        toolCtx(f),
      ));
      expect(res.transaction_id).toBe(txId);
    });
  });
});
