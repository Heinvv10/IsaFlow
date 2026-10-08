/**
 * A GL account merge must not strand an open customer invoice's lines on a
 * target the invoice-line guard refuses — a header account, including one that
 * becomes a header by taking the source's children (migration 874). The merge
 * refuses `target_refused_for_open_invoice_lines`, naming the invoices, before
 * it writes (dry run and live) and again after it, on exactly the lines it
 * moved: a draft line landing on the source between the two checks is caught
 * by the second. A posted invoice's line, and any line onto a leaf target, moves.
 *
 * Runs inside a transaction that is ROLLED BACK, on a company the fixture
 * creates for itself, as the other account-merge suites do.
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

// The swap hook (last case): set to run once inside the dry-run count, after assertMergeable.
let onCount: (() => Promise<void>) | null = null;
vi.mock('../../src/modules/accounting/services/gl/accountMergeDocumentRows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/accounting/services/gl/accountMergeDocumentRows')>();
  return {
    ...actual,
    countDocumentRows: async (...args: Parameters<typeof actual.countDocumentRows>) => {
      const counted = await actual.countDocumentRows(...args);
      const hook = onCount;
      onCount = null;
      if (hook) await hook();
      return counted; // stale on purpose: the count from before the swap
    },
  };
});

import { mergeAccounts, AccountMergeError } from '../../src/modules/accounting/services/gl/accountMergeService';
import { previewAccountMerge } from '../../src/modules/accounting/services/gl/accountMergePreview';

async function withFixture(fn: (c: PoolClient, f: MergeFixture) => Promise<void>): Promise<void> {
  assertMergeTestDb();
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const f = await createMergeFixture(client);
    await als.run({ client, userId: USER, companyId: f.companyId, claims: {} } as unknown as Ctx, () => fn(client, f));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function one(c: PoolClient, text: string, params: unknown[]): Promise<string> {
  return (await c.query<{ id: string }>(text, params)).rows[0]!.id;
}

/** A customer invoice with one line on `accountId`; posted means its journal is posted. Returns the line id. */
async function invoiceLine(c: PoolClient, companyId: string, accountId: string, posted: boolean, number: string): Promise<string> {
  const customer = await one(c, 'INSERT INTO customers (company_id, name) VALUES ($1, $2) RETURNING id', [companyId, `ZZ ${number}`]);
  const journal = posted ? await one(c,
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by)
     VALUES ($1, $2, CURRENT_DATE, 'invoice fixture', 'posted', $3) RETURNING id`, [companyId, `ZZ-JE-${number}`, USER]) : null;
  const invoice = await one(c,
    `INSERT INTO customer_invoices (company_id, invoice_number, customer_id, client_id, subtotal, total_amount,
       created_by, status, gl_journal_entry_id)
     VALUES ($1, $2, $3, $3, 100, 115, $4, $5, $6) RETURNING id`,
    [companyId, number, customer, USER, posted ? 'approved' : 'draft', journal]);
  return one(c,
    `INSERT INTO customer_invoice_items (invoice_id, description, quantity, unit_price, amount, gl_account_id)
     VALUES ($1, 'merge fixture', 1, 100, 100, $2) RETURNING id`, [invoice, accountId]);
}

const accountOf = async (c: PoolClient, lineId: string) => String((await c.query<{ a: string }>(
  'SELECT gl_account_id::text AS a FROM customer_invoice_items WHERE id = $1', [lineId])).rows[0]!.a);

async function refusal(fn: () => Promise<unknown>): Promise<AccountMergeError | null> {
  return fn().then(() => null, (e: unknown) => {
    expect(e).toBeInstanceOf(AccountMergeError);
    return e as AccountMergeError;
  });
}

describe.skipIf(!hasDb)('the merge and open customer invoice lines', () => {
  it('refuses, dry run and live, when a draft invoice line would move onto a header target; nothing moves', async () => {
    await withFixture(async (c, f) => {
      // The fixture's target already has a child (targetChildId): a header.
      const line = await invoiceLine(c, f.companyId, f.cleanSourceId, false, 'ZZ-CI-DRAFT');
      for (const attempt of [
        () => previewAccountMerge(f.companyId, f.cleanSourceId, f.targetId),
        () => mergeAccounts(f.companyId, f.cleanSourceId, f.targetId, USER),
      ]) {
        const err = await refusal(attempt);
        expect(err?.code).toBe('target_refused_for_open_invoice_lines');
        expect(err?.message).toMatch(/ZZ-CI-DRAFT/);
      }
      expect(await accountOf(c, line)).toBe(f.cleanSourceId);
    });
  }, 120_000);

  it('a posted invoice\'s line, and a cancelled one\'s, move onto the header target', async () => {
    await withFixture(async (c, f) => {
      const line = await invoiceLine(c, f.companyId, f.cleanSourceId, true, 'ZZ-CI-POSTED');
      const cancelled = await invoiceLine(c, f.companyId, f.cleanSourceId, false, 'ZZ-CI-CANCELLED');
      await c.query(`UPDATE customer_invoices SET status = 'cancelled'
                      WHERE id = (SELECT invoice_id FROM customer_invoice_items WHERE id = $1)`, [cancelled]);
      await mergeAccounts(f.companyId, f.cleanSourceId, f.targetId, USER);
      expect(await accountOf(c, line)).toBe(f.targetId);
      expect(await accountOf(c, cancelled)).toBe(f.targetId);
    });
  }, 120_000);

  it('refuses a leaf target that would BECOME a header by taking the source\'s children', async () => {
    await withFixture(async (c, f) => {
      await c.query(
        `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, parent_account_id)
         VALUES ($1, 'ZZ-SRC-KID', 'Source child', 'asset', 'debit', 4, $2)`, [f.companyId, f.cleanSourceId]);
      const line = await invoiceLine(c, f.companyId, f.cleanSourceId, false, 'ZZ-CI-KIDS');
      const err = await refusal(() => mergeAccounts(f.companyId, f.cleanSourceId, f.targetChildId, USER));
      expect(err?.code).toBe('target_refused_for_open_invoice_lines');
      expect(await accountOf(c, line)).toBe(f.cleanSourceId);
    });
  }, 120_000);

  it('a draft invoice\'s line moves onto a leaf target', async () => {
    await withFixture(async (c, f) => {
      const line = await invoiceLine(c, f.companyId, f.cleanSourceId, false, 'ZZ-CI-LEAF');
      await mergeAccounts(f.companyId, f.cleanSourceId, f.targetChildId, USER);
      expect(await accountOf(c, line)).toBe(f.targetChildId);
    });
  }, 120_000);

  it('after the write: a draft line that landed on the source past the first check is refused, and nothing stays moved', async () => {
    await withFixture(async (c, f) => {
      const elsewhere = f.cleanSourceTwoId;
      // A posted invoice on the source: the pre-write check rightly ignores it,
      // and it keeps the per-table count at 1 across the swap.
      const posted = await invoiceLine(c, f.companyId, f.cleanSourceId, true, 'ZZ-CI-SWAP-POSTED');
      let injected = '';
      onCount = async () => {
        await c.query('UPDATE customer_invoice_items SET gl_account_id = $1 WHERE id = $2', [elsewhere, posted]);
        injected = await invoiceLine(c, f.companyId, f.cleanSourceId, false, 'ZZ-CI-SWAP-DRAFT');
      };
      const err = await refusal(() => mergeAccounts(f.companyId, f.cleanSourceId, f.targetId, USER));
      expect(injected).not.toBe('');
      expect(err?.code).toBe('target_refused_for_open_invoice_lines');
      expect(err?.message).toMatch(/ZZ-CI-SWAP-DRAFT/);
      const onTarget = await c.query<{ n: number }>(
        'SELECT COUNT(*)::INT AS n FROM customer_invoice_items WHERE gl_account_id = $1', [f.targetId]);
      expect(onTarget.rows[0]!.n).toBe(0);
    });
  }, 120_000);
});
