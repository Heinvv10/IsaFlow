/**
 * Tier 3 SQL against isaflow_dev: the three new query/write services plus the
 * escaped description search. Mocked tests prove the tools call the services
 * correctly; only a real database can prove the null-safe filters, the keyset
 * predicate and the LIKE escaping actually do what they say.
 *
 * Runs inside BEGIN … ROLLBACK on an ALS-bound client; nothing survives.
 * DB-gated: skips when no DB is reachable.
 */
import { describe, it, expect, vi } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests, sql } from '@/lib/neon';
import { listImportBatches } from '@/modules/accounting/services/bank/bankImportBatchQueryService';
import { listJournalEntriesPage } from '@/modules/accounting/services/gl/journalEntryListService';
import { addBankTxAttachment } from '@/modules/accounting/services/bank/bankTxAttachmentService';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import { escapeLikeLiteral } from '@/lib/mcp/tools/bank';

type AlsCtx = Parameters<typeof als.run>[0];
const alsCtx = (client: unknown, companyId: string): AlsCtx =>
  ({ client, userId: 'test', companyId, claims: {} } as unknown as AlsCtx);

const OTHER = '99999999-9999-4999-8999-999999999999';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

async function fixture() {
  const rows = (await sql`
    SELECT company_id, id AS bank_account_id FROM gl_accounts
    WHERE account_subtype = 'bank' ORDER BY company_id, account_code LIMIT 1
  `) as Array<{ company_id: string; bank_account_id: string }>;
  if (!rows[0]) throw new Error('no bank account in isaflow_dev');
  return rows[0];
}

async function inTx(run: (f: { companyId: string; bankAccountId: string }) => Promise<void>) {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run(alsCtx(client, 'bootstrap'), async () => {
      const f = await fixture();
      await als.run(alsCtx(client, f.company_id), () =>
        run({ companyId: f.company_id, bankAccountId: f.bank_account_id }));
    });
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('Tier 3 services — real database', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('list_import_batches counts remaining/allocated live and is tenant-fenced', async () => {
    await inTx(async ({ companyId, bankAccountId }) => {
      const [b] = (await sql`
        INSERT INTO bank_import_batches (company_id, bank_account_id, statement_date, transaction_count, source_filename)
        VALUES (${companyId}::uuid, ${bankAccountId}::uuid, '2026-08-31', 3, 'tier3.ofx') RETURNING id
      `) as Array<{ id: string }>;
      await sql`
        INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, import_batch_id)
        VALUES (${companyId}::uuid, ${bankAccountId}::uuid, '2026-08-30', -1, 'T3 A', ${b!.id}::uuid),
               (${companyId}::uuid, ${bankAccountId}::uuid, '2026-08-30', -2, 'T3 B', ${b!.id}::uuid)
      `;
      const mine = await listImportBatches(companyId, { bankAccountId });
      const row = mine.find((x) => x.id === b!.id);
      expect(row).toMatchObject({ transactionCount: 3, transactionsRemaining: 2, transactionsAllocated: 0, sourceFilename: 'tier3.ofx' });
      expect(mine[0]!.id).toBe(b!.id); // newest first
      expect((await listImportBatches(OTHER)).find((x) => x.id === b!.id)).toBeUndefined();
    });
  });

  it.skipIf(!reachable)('list_journals pages by keyset without repeats and honours every filter', async () => {
    await inTx(async ({ companyId }) => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const [je] = (await sql`
          INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by)
          VALUES (${companyId}::uuid, ${`T3-${i}`}, '1999-01-15', ${`tier3 ${i}`}, 'manual', 'draft',
                  '00000000-0000-0000-0000-000000000000') RETURNING id
        `) as Array<{ id: string }>;
        ids.push(je!.id);
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await listJournalEntriesPage(companyId, {
          fromDate: '1999-01-15', toDate: '1999-01-15', source: 'manual', limit: 2, cursor,
        });
        seen.push(...page.entries.map((e) => e.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen.sort()).toEqual([...ids].sort());
      expect(new Set(seen).size).toBe(3);

      const win = { fromDate: '1999-01-01', toDate: '1999-01-31' };
      const drafts = await listJournalEntriesPage(companyId, { ...win, status: 'draft' });
      expect(drafts.entries).toHaveLength(3);
      expect(drafts.entries[0]!.lines).toBeUndefined();
      const posted = await listJournalEntriesPage(companyId, { ...win, status: 'posted' });
      expect(posted.entries).toHaveLength(0);
      const other = await listJournalEntriesPage(companyId, { ...win, source: 'bank' });
      expect(other.entries).toHaveLength(0);
      const none = await listJournalEntriesPage(companyId, { ...win, toDate: '1999-01-14' });
      expect(none.entries).toHaveLength(0);
      const withLines = await listJournalEntriesPage(companyId, { ...win, includeLines: true, limit: 1 });
      expect(withLines.entries[0]!.lines).toEqual([]);
      const foreign = await listJournalEntriesPage(OTHER, win);
      expect(foreign.entries).toHaveLength(0);
    });
  });

  it.skipIf(!reachable)('attach_document stores a data URL and refuses a foreign transaction', async () => {
    await inTx(async ({ companyId, bankAccountId }) => {
      const [tx] = (await sql`
        INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description)
        VALUES (${companyId}::uuid, ${bankAccountId}::uuid, '2026-08-30', -5, 'T3 ATTACH') RETURNING id
      `) as Array<{ id: string }>;
      const input = { bankTransactionId: tx!.id, fileName: 'slip.png', mimeType: 'image/png' as const, bytes: PNG, maxBytes: 1024, uploadedBy: null };
      const res = await addBankTxAttachment(companyId, input);
      expect(res.ok).toBe(true);
      const [stored] = (await sql`
        SELECT file_url, file_size FROM bank_transaction_attachments WHERE bank_transaction_id = ${tx!.id}::uuid
      `) as Array<{ file_url: string; file_size: number }>;
      expect(stored!.file_url.startsWith('data:image/png;base64,')).toBe(true);
      expect(Number(stored!.file_size)).toBe(PNG.length);

      expect(await addBankTxAttachment(OTHER, input)).toEqual({ ok: false, reason: 'bank_tx_not_found' });
      expect(await addBankTxAttachment(companyId, { ...input, mimeType: 'application/pdf' })).toEqual({ ok: false, reason: 'type_mismatch' });
    });
  });

  it.skipIf(!reachable)('description_contains is a literal match — % does not wildcard', async () => {
    await inTx(async ({ companyId, bankAccountId }) => {
      await sql`
        INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description)
        VALUES (${companyId}::uuid, ${bankAccountId}::uuid, '2026-08-30', -1, 'T3 SALE 50% OFF'),
               (${companyId}::uuid, ${bankAccountId}::uuid, '2026-08-30', -2, 'T3 SALE 50 OFF')
      `;
      const literal = await getBankTransactions(companyId, { search: escapeLikeLiteral('50% off') });
      expect(literal.transactions.map((t) => t.description)).toEqual(['T3 SALE 50% OFF']);
      const raw = await getBankTransactions(companyId, { search: 't3 sale 50% off' });
      expect(raw.transactions).toHaveLength(2); // the unescaped service behaviour the tool guards against
    });
  });
});
