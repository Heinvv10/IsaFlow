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
import {
  bankTxRefCandidateQuery,
  findBankTransactionsByReference,
  findBankTransactionsByReferences,
} from '@/modules/accounting/services/bank/bankTransactionLookupService';
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

  it.skipIf(!reachable)('reaches a stored reference that ends in a control character', async () => {
    // `.trim()` in JS strips \r; bare btrim() in SQL strips spaces only, so a
    // statement row imported as "REF\r" was unreachable from an agent typing
    // "REF". Only real SQL can show this — the trim set lives in the query.
    await inRequestTx(async (f) => {
      const ref = `ISAFLOW-CRLF-${Date.now()}`;
      await seedTx(f, `${ref}\r`, 'ISAFLOW REF FIXTURE crlf');
      const matches = await findBankTransactionsByReference(f.companyId, ref);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.matchedReference).toBe(ref);
    });
  });

  it.skipIf(!reachable)('prefers `reference` over `bank_reference` for the same value', async () => {
    await inRequestTx(async (f) => {
      const ref = `ISAFLOW-PREF-${Date.now()}`;
      const onReference = await seedTx(f, ref, 'ISAFLOW REF FIXTURE preferred');
      // The same string as a feed's external id on a different row. A UNION
      // would report these two as ambiguous and refuse to allocate either.
      await sql`
        INSERT INTO bank_transactions (
          company_id, bank_account_id, transaction_date, amount, description,
          reference, bank_reference, status
        ) VALUES (
          ${f.companyId}::uuid, ${f.bankAccountId}::uuid, '2026-08-03'::date,
          ${-42}, 'ISAFLOW REF FIXTURE shadowed', NULL, ${ref}, 'imported'
        )
      `;
      const matches = await findBankTransactionsByReference(f.companyId, ref);
      expect(matches.map((m) => m.id)).toEqual([onReference]);
      expect(matches[0]!.matchedColumn).toBe('reference');
    });
  });

  it.skipIf(!reachable)('resolves a whole batch of references in one query', async () => {
    await inRequestTx(async (f) => {
      const stamp = Date.now();
      const refs = [`ISAFLOW-BATCH-${stamp}-A`, `ISAFLOW-BATCH-${stamp}-B`];
      const ids = [
        await seedTx(f, refs[0]!, 'ISAFLOW REF FIXTURE batch a'),
        await seedTx(f, refs[1]!, 'ISAFLOW REF FIXTURE batch b'),
      ];
      const byRef = await findBankTransactionsByReferences(f.companyId, [...refs, 'ISAFLOW-BATCH-MISSING']);
      expect(byRef.get(refs[0]!)!.map((m) => m.id)).toEqual([ids[0]]);
      expect(byRef.get(refs[1]!)!.map((m) => m.id)).toEqual([ids[1]]);
      expect(byRef.has('ISAFLOW-BATCH-MISSING')).toBe(false);
    });
  });

  it.skipIf(!reachable)('is served by migration 519’s expression indexes, not a company scan', async () => {
    // Plans the SERVICE'S OWN statement — `.text`/`.values` off the unrun lazy
    // query — not a copy pasted into the test. A copy stays green while the
    // service regresses to a bare `btrim()` no index can serve, which is the
    // only regression this test exists to catch.
    await inRequestTx(async (f) => {
      const ref = `ISAFLOW-PLAN-${Date.now()}`;
      await seedTx(f, ref, 'ISAFLOW REF FIXTURE plan');

      const query = bankTxRefCandidateQuery(f.companyId, [ref], null) as unknown as {
        text: string; values: unknown[];
      };
      const client = (als.getStore() as unknown as { client: {
        query(text: string, values: unknown[]): Promise<{ rows: Array<Record<string, string>> }>;
      } }).client;
      const res = await client.query(`EXPLAIN (FORMAT TEXT) ${query.text}`, query.values);
      const plan = res.rows.map((r) => Object.values(r)[0]).join('\n');

      expect(plan).toContain('idx_bt_company_reference_trim');
      expect(plan).toContain('idx_bt_company_bank_reference_trim');
      expect(plan).not.toMatch(/Seq Scan on bank_transactions/);
    });
  });

  it.skipIf(!reachable)('labels a row once per matching reference, not once per row', async () => {
    // A row can carry ONE reference in `reference` and a DIFFERENT one in
    // `bank_reference`, and a batch can ask for both. Deciding the row's label
    // from "did its `reference` match ANY reference in the batch?" made it
    // vanish from the OTHER reference's candidates, so a 500-line bulk call
    // resolved fewer rows than the same references resolved one at a time —
    // silently, as NOT_FOUND.
    await inRequestTx(async (f) => {
      const stamp = Date.now();
      const onReference = `ISAFLOW-ZPC-${stamp}`;
      const onBankReference = `ISAFLOW-ZPD-${stamp}`;
      const rows = (await sql`
        INSERT INTO bank_transactions (
          company_id, bank_account_id, transaction_date, amount, description,
          reference, bank_reference, status
        ) VALUES (
          ${f.companyId}::uuid, ${f.bankAccountId}::uuid, '2026-08-03'::date,
          ${-55}, 'ISAFLOW REF FIXTURE two-column', ${onReference}, ${onBankReference}, 'imported'
        )
        RETURNING id
      `) as Array<{ id: string }>;
      const txId = String(rows[0]!.id);

      const batch = await findBankTransactionsByReferences(
        f.companyId, [onReference, onBankReference],
      );
      // Both references resolve to the row, each labelled with the column that
      // actually carried it.
      expect(batch.get(onReference)!.map((m) => [m.id, m.matchedColumn]))
        .toEqual([[txId, 'reference']]);
      expect(batch.get(onBankReference)!.map((m) => [m.id, m.matchedColumn]))
        .toEqual([[txId, 'bank_reference']]);

      // …and a batch answers exactly what the single lookups answer.
      expect(batch.get(onBankReference))
        .toEqual(await findBankTransactionsByReference(f.companyId, onBankReference));
      expect(batch.get(onReference))
        .toEqual(await findBankTransactionsByReference(f.companyId, onReference));
    });
  });

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
