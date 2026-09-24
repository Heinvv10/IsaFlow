/**
 * A same-table swap between the merge's bill-line check and its write.
 *
 * `openBillLinesRefusal` (assertMergeable) runs ONCE, early — before
 * `repointMovableLines` and well before `repointDocumentRows`, the write that
 * actually moves rows and is driven entirely by LIVE database state. Nothing
 * locks `supplier_invoice_items`/`supplier_invoices` for the rest of the
 * transaction, and the write-time safety net
 * (`documentRowsRepointed[t] !== preview.documentRowsToRepoint[t]`) is a
 * PER-TABLE COUNT, not an identity check.
 *
 * A same-table swap defeats both: a bill on source whose journal is ALREADY
 * POSTED (so `openBillLinesRefusal` rightly ignores it) gets its line recoded
 * OFF source, and in the same instant a brand-new DRAFT bill lands ON source.
 * `supplier_invoice_items` count on source is unchanged (1 before, 1 after),
 * so the count check passes — with the WRONG row satisfying it. The draft
 * line, never seen by `openBillLinesRefusal`, moves onto the refused
 * (`payable`-subtype) target and would be permanently unapprovable.
 *
 * Forced deterministically (rather than racing two real connections) by
 * wrapping `countDocumentRows` — the read `previewAccountMerge` takes right
 * after its own `assertMergeable` call — to perform the swap immediately
 * after computing its real count and return that now-stale count unchanged,
 * standing in for a second connection's commit landing in that window.
 *
 * Asserted: the live merge REJECTS with `AccountMergeError` code
 * `target_refused_for_open_bill_lines` (the post-write check on the exact
 * lines that moved), and no bill line is left on the target (the merge's own
 * savepoint undid the write). be0636c4c let it through.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { getPoolForTests } from '../../src/lib/neon';
import { assertMergeTestDb, createMergeFixture, type MergeFixture } from '../unit/helpers/accountMergeFixture';

vi.mock('../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const USER = '00000000-0000-0000-0000-0000000000aa';
const hasDb = !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('dummy');

type Ctx = Parameters<typeof als.run>[0];

async function withFixture(fn: (c: PoolClient, f: MergeFixture) => Promise<void>): Promise<void> {
  assertMergeTestDb();
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const f = await createMergeFixture(client);
    const ctx = { client, userId: USER, companyId: f.companyId, claims: {} } as unknown as Ctx;
    await als.run(ctx, () => fn(client, f));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function one(c: PoolClient, text: string, params: unknown[]): Promise<string> {
  const { rows } = await c.query<{ id: string }>(text, params);
  return rows[0]!.id;
}

describe.skipIf(!hasDb)('the open-bill-lines guard and the count check both miss a same-table swap', () => {
  it('rejects a merge where a posted bill is recoded off source and a draft bill lands on it in the same window', async () => {
    let swapped = false;
    let testClient!: PoolClient;
    let testCompanyId!: string;
    let sourceId!: string;
    let elsewhereAccountId!: string;
    let postedItemId!: string;
    let injectedItemId: string | undefined;
    let injectedInvoiceId: string | undefined;

    vi.doMock('../../src/modules/accounting/services/gl/accountMergeDocumentRows', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/modules/accounting/services/gl/accountMergeDocumentRows')>();
      return {
        ...actual,
        countDocumentRows: async (...args: Parameters<typeof actual.countDocumentRows>) => {
          const result = await actual.countDocumentRows(...args);
          if (!swapped && testClient && testCompanyId && sourceId) {
            swapped = true;
            // The posted bill's line moves OFF source (a data fix, a different
            // request — anything not going through this merge).
            await testClient.query(
              'UPDATE supplier_invoice_items SET gl_account_id = $1 WHERE id = $2',
              [elsewhereAccountId, postedItemId]);
            // A brand-new DRAFT bill lands ON source in the same instant —
            // never seen by `openBillLinesRefusal`, which already ran.
            const supplier = await one(testClient,
              `INSERT INTO suppliers (company_id, name) VALUES ($1, 'ZZ swap supplier') RETURNING id`,
              [testCompanyId]);
            injectedInvoiceId = await one(testClient,
              `INSERT INTO supplier_invoices (company_id, invoice_number, supplier_id, invoice_date,
                 subtotal, total_amount, created_by, status)
               VALUES ($1, 'ZZ-SWAP-INV', $2, CURRENT_DATE, 100, 100, $3, 'draft') RETURNING id`,
              [testCompanyId, supplier, USER]);
            injectedItemId = await one(testClient,
              `INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, line_total, gl_account_id)
               VALUES ($1, 'swap fixture', 1, 100, 100, $2) RETURNING id`,
              [injectedInvoiceId, sourceId]);
          }
          // Stale on purpose: the count from BEFORE the swap, so the write-time
          // count (still 1 — one row left, one arrived) matches it.
          return result;
        },
      };
    });
    const { mergeAccounts, AccountMergeError } = await import(
      '../../src/modules/accounting/services/gl/accountMergeService');

    await withFixture(async (c, f) => {
      testClient = c;
      testCompanyId = f.companyId;

      sourceId = await one(c,
        `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
         VALUES ($1, 'ZZ-SWAP-SRC', 'Swap guard source', 'liability', 'credit', 3) RETURNING id`,
        [f.companyId]);
      const target = await one(c,
        `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, level)
         VALUES ($1, 'ZZ-SWAP-TGT', 'Swap guard target', 'liability', 'payable', 'credit', 3) RETURNING id`,
        [f.companyId]);
      elsewhereAccountId = await one(c,
        `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
         VALUES ($1, 'ZZ-SWAP-ELSE', 'Swap guard elsewhere', 'liability', 'credit', 3) RETURNING id`,
        [f.companyId]);

      // A bill on source that's ALREADY POSTED — `openBillLinesRefusal` rightly
      // ignores it (moving a posted bill's line is fine), and it exists so the
      // per-table count is 1 before AND after the swap.
      const dummyEntry = await one(c,
        `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by)
         VALUES ($1, 'ZZ-SWAP-JE', CURRENT_DATE, 'swap fixture posted entry', 'posted', $2) RETURNING id`,
        [f.companyId, USER]);
      const supplier = await one(c,
        `INSERT INTO suppliers (company_id, name) VALUES ($1, 'ZZ swap posted supplier') RETURNING id`, [f.companyId]);
      const invoice = await one(c,
        `INSERT INTO supplier_invoices (company_id, invoice_number, supplier_id, invoice_date,
           subtotal, total_amount, created_by, status, gl_journal_entry_id)
         VALUES ($1, 'ZZ-SWAP-POSTED', $2, CURRENT_DATE, 100, 100, $3, 'approved', $4) RETURNING id`,
        [f.companyId, supplier, USER, dummyEntry]);
      postedItemId = await one(c,
        `INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, line_total, gl_account_id)
         VALUES ($1, 'posted fixture', 1, 100, 100, $2) RETURNING id`, [invoice, sourceId]);

      // Both `openBillLinesRefusal` calls (direct + inside previewAccountMerge)
      // see only the posted bill: clean, no refusal — the race is what should
      // still stop this, on the write side.
      let code: string | undefined;
      try {
        await mergeAccounts(f.companyId, sourceId, target, USER);
      } catch (err) {
        expect(err).toBeInstanceOf(AccountMergeError);
        code = (err as InstanceType<typeof AccountMergeError>).code;
      }
      expect(code).toBe('target_refused_for_open_bill_lines');
      expect(swapped).toBe(true);
      expect(injectedItemId).toBeDefined();

      // Nothing landed on the refused target. The swap is simulated inside the
      // merge's own transaction, so the merge's savepoint rolls the injected
      // draft back with it; a real concurrent commit would stay on source. In
      // both cases no bill line may be on the target.
      const { rows } = await c.query<{ n: number }>(
        'SELECT COUNT(*)::INT AS n FROM supplier_invoice_items WHERE gl_account_id = $1', [target]);
      expect(rows[0]!.n).toBe(0);
    });
  }, 120_000);
});
