/**
 * Migration 870, quotes: a quote line's account is copied onto the invoice its
 * conversion raises, and posting credits it — so the quote is held to the
 * invoice-line rules when it is saved (create and update) and again when it is
 * converted (a quote saved before 870 was never checked), each before anything
 * is written: an expense account and another company's account are refused
 * with INVOICE_LINE_CODING_REFUSED; a revenue account converts and posts.
 *
 * Disposable databases only (migrations 869 and 870 are not on isaflow_dev).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { createQuote, updateQuote } from '@/modules/accounting/services/ar/quoteService';
import { convertToInvoice } from '@/modules/accounting/services/ar/quoteConvertService';
import { InvoiceLineCodingRefusal } from '@/modules/accounting/services/ar/invoiceLineCoding';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;

const input = (accountId?: string) => ({
  customerName: 'Studio client', clientId: f.fx.customerId, quoteDate: '2026-07-10',
  lines: [{ description: 'Shoot', quantity: 1, unitPrice: 1000, taxRate: 0, ...(accountId ? { accountId } : {}) }],
});
const quoteCount = async () => Number(((await sql`
  SELECT COUNT(*) AS n FROM customer_quotes WHERE company_id = ${f.fx.companyId}::UUID`) as { n: string }[])[0]!.n);

/** An accepted quote whose line names `accountId`, written directly — as a quote saved before 870 could be. */
async function acceptedQuote(accountId: string): Promise<string> {
  const q = await inTx(f.fx, () => createQuote(f.fx.companyId, input(), f.fx.userId));
  await sql`UPDATE customer_quote_lines SET gl_account_id = ${accountId}::UUID WHERE quote_id = ${q.id}::UUID`;
  await sql`UPDATE customer_quotes SET status = 'accepted' WHERE id = ${q.id}::UUID`;
  return q.id;
}

describeIfDisposable('quote line accounts (migration 870)', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => {
    if (!f) return;
    await sql`DELETE FROM customer_quote_lines WHERE quote_id IN (SELECT id FROM customer_quotes WHERE company_id = ${f.fx.companyId}::UUID)`;
    await sql`UPDATE customer_quotes SET converted_invoice_id = NULL WHERE company_id = ${f.fx.companyId}::UUID`;
    await sql`DELETE FROM customer_quotes WHERE company_id = ${f.fx.companyId}::UUID`;
    await dropLineRevenue(f);
  });

  it.each([
    ['an expense account', () => f.acct.expense, /6100 Crew.*not a revenue account/],
    ['another company\'s account', () => f.acct.foreign, /not in your company/],
  ])('create and update refuse a line coded to %s, before writing', async (_label, account, message) => {
    const before = await quoteCount();
    const created = await inTx(f.fx, () => createQuote(f.fx.companyId, input(account()), f.fx.userId)).catch((e: unknown) => e);
    expect(created).toBeInstanceOf(InvoiceLineCodingRefusal);
    expect((created as Error).message).toMatch(message);
    expect(await quoteCount()).toBe(before);

    const q = await inTx(f.fx, () => createQuote(f.fx.companyId, input(f.acct.commercials), f.fx.userId));
    const updated = await inTx(f.fx, () => updateQuote(f.fx.companyId, q.id, input(account()), f.fx.userId)).catch((e: unknown) => e);
    expect(updated).toBeInstanceOf(InvoiceLineCodingRefusal);
    const kept = (await sql`SELECT gl_account_id FROM customer_quote_lines WHERE quote_id = ${q.id}::UUID`) as { gl_account_id: string }[];
    expect(kept).toEqual([{ gl_account_id: f.acct.commercials }]);
  });

  it.each([
    ['an expense account', () => f.acct.expense],
    ['another company\'s account', () => f.acct.foreign],
  ])('conversion refuses a quote whose line names %s, before the claim — the quote stays accepted', async (_label, account) => {
    const id = await acceptedQuote(account());
    const err = await inTx(f.fx, () => convertToInvoice(f.fx.companyId, id, f.fx.userId)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceLineCodingRefusal);
    expect(((await sql`SELECT status, converted_invoice_id FROM customer_quotes WHERE id = ${id}::UUID`) as Record<string, unknown>[])[0])
      .toEqual({ status: 'accepted', converted_invoice_id: null });
  });

  it('a quote coded to a revenue account converts with the account on the invoice line', async () => {
    const id = await acceptedQuote(f.acct.commercials);
    const out = await inTx(f.fx, () => convertToInvoice(f.fx.companyId, id, f.fx.userId));
    const lines = (await sql`SELECT gl_account_id FROM customer_invoice_items WHERE invoice_id = ${out!.invoiceId}::UUID`) as { gl_account_id: string }[];
    expect(lines).toEqual([{ gl_account_id: f.acct.commercials }]);
  });
});
