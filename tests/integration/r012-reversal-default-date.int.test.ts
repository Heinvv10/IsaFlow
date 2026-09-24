/**
 * R-012 — the DEFAULT reversal date, on real PostgreSQL.
 *
 * 1. resolveReversalDate's default arm dated the contra TODAY whenever the
 *    original's period was not open — including when the original is dated
 *    AFTER today. A correction dated before what it corrects breaks the as-at
 *    parity the ageing and statements read (softDeleteLedgerPresence). Now
 *    refused pre-write as ReversalBeforeOriginalError (a ClosedFiscalPeriodError).
 * 2. The MCP reverse tool resolved that default read-only but never asked
 *    whether today's period is open, so dry_run promised a reversal the live
 *    call could not post, and the live call failed inside the write path.
 *
 * Periods are built relative to today so the test holds on any date.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { ReversalBeforeOriginalError } from '@/modules/accounting/services/gl/journalEntryReversalDate';
import { ClosedFiscalPeriodError } from '@/modules/accounting/services/gl/journalEntryPostingGuards';
import { reverseJournalEntryTool } from '@/lib/mcp/tools/writeJournalReverse';
import { cancelCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';
import { cancelSupplierInvoiceTool } from '@/lib/mcp/tools/writeCancelSupplierInvoice';
import { SignJWT } from 'jose';
import { request, response } from './mfa-impersonation-postgres.helpers';
import supplierCreditNotesRoute from '../../pages/api/accounting/supplier-credit-notes';
import { lockPaymentBankLeg } from '@/modules/accounting/services/ap/paymentJournalReversal';
import { isSupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: Fixture;
let seq = 0;
const acc: Record<string, string> = {};

const day = (offset: number): string => { const d = new Date(); d.setDate(d.getDate() + offset); return fmtDate(d); };

async function account(subtype: string): Promise<string> {
  return String(((await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = ${subtype} LIMIT 1`) as Row[])[0]!.id);
}

/** Replace the fixture's periods (before anything posts): [start..end] with a status each. */
async function periods(ranges: Array<[string, string, 'open' | 'closed']>): Promise<void> {
  await sql`DELETE FROM gl_account_balances WHERE fiscal_period_id IN (
    SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID)`;
  await sql`UPDATE gl_journal_entries SET fiscal_period_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
  await sql`DELETE FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID`;
  let n = 0;
  for (const [start, end, status] of ranges) {
    n++;
    await sql`
      INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${fx.companyId}::UUID, ${`R012-${n}-${fx.tag}`}, ${n}, ${2100 + n}, ${start}::DATE, ${end}::DATE, ${status})`;
  }
}

async function postedJournal(date: string): Promise<string> {
  const je = String(((await sql`
    INSERT INTO gl_journal_entries
      (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at, source)
    VALUES (${fx.companyId}::UUID, ${`R012-${++seq}-${fx.tag}`}, ${date}::DATE, 'orig', 'posted', ${fx.userId}::UUID,
            (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID
               AND start_date <= ${date}::DATE AND end_date >= ${date}::DATE LIMIT 1), NOW(), 'manual')
    RETURNING id`) as Row[])[0]!.id);
  await sql`
    INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${fx.companyId}::UUID, ${je}::UUID, ${acc.expense!}::UUID, 100, 0, 'exp'),
           (${fx.companyId}::UUID, ${je}::UUID, ${acc.ap!}::UUID, 0, 100, 'ap')`;
  return je;
}

const entryCount = async (): Promise<number> => Number(((await sql`
  SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Row[])[0]!.n);
const ctx = () => ({ companyId: fx.companyId, userId: fx.userId, tokenJti: 'jti-r012', scopes: [] }) as unknown as McpToolContext;

describeIfDb('R-012: the default reversal date', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts and reverses journals.');
    fx = await seedFixture('R012', DATABASE_URL!);
    acc.expense = await account('default_expense');
    acc.ap = await account('payable');
    // One layout for every case: today sits in a CLOSED period; an open window
    // follows it, then a closed one.
    await periods([[day(-400), day(10), 'closed'], [day(11), day(30), 'open'], [day(31), day(100), 'closed']]);
  }, 120000);

  afterAll(async () => {
    await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('refuses, writing nothing, to date a reversal today when the future-dated original\'s period is closed', async () => {
    const je = await postedJournal(day(40));
    const before = await entryCount();
    const err = await inTx(fx, () => reverseJournalEntry(fx.companyId, je, fx.userId)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReversalBeforeOriginalError);
    expect(err).toBeInstanceOf(ClosedFiscalPeriodError);
    expect(await entryCount()).toBe(before);
  });

  it('still dates a future-dated original\'s reversal to the original when its period is open', async () => {
    const je = await postedJournal(day(20));
    const r = await inTx(fx, () => reverseJournalEntry(fx.companyId, je, fx.userId));
    expect(fmtDate(r.entryDate)).toBe(day(20));
  });

  // Review round 1 (adversarial): the new refusal has to arrive as each
  // caller's own typed refusal, or it becomes a 500 / a GENERIC_FAILURE retry.
  it('an AP payment void refuses with a SupplierPaymentRefusal (a 4xx), not a raw error', async () => {
    const je = await postedJournal(day(40));
    const pid = String(((await sql`
      INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, created_by, status, gl_journal_entry_id)
      VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, ${day(40)}::DATE, 100, ${fx.userId}, 'processed', ${je}::UUID)
      RETURNING id`) as Row[])[0]!.id);
    const err = await inTx(fx, () => lockPaymentBankLeg(fx.companyId, pid)).catch((e: unknown) => e);
    expect(isSupplierPaymentRefusal(err)).toBe(true);
    expect((err as Error).message).toMatch(/would precede it/);
    await sql`DELETE FROM supplier_payments WHERE id = ${pid}::UUID`;
  });

  it('cancel_credit_note answers with a toolError, not a thrown GENERIC_FAILURE', async () => {
    const je = await postedJournal(day(40));
    const cn = String(((await sql`
      INSERT INTO credit_notes (company_id, type, credit_date, subtotal, total_amount, created_by, status,
                                client_id, gl_journal_entry_id, credit_note_number)
      VALUES (${fx.companyId}::UUID, 'customer', ${day(40)}::DATE, 100, 100, ${fx.userId}, 'approved',
              ${fx.customerId}::UUID, ${je}::UUID, ${`R012-${fx.tag.slice(-12)}`})
      RETURNING id`) as Row[])[0]!.id);
    const out = await inTx(fx, () => cancelCreditNoteTool.handler(
      { credit_note_id: cn, idempotency_key: `r012-cn-${fx.tag}` }, ctx()));
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.content)).toMatch(/would precede it/);
    await sql`DELETE FROM credit_notes WHERE id = ${cn}::UUID`;
  });

  it('cancel_supplier_invoice answers with a toolError, not a thrown GENERIC_FAILURE', async () => {
    const je = await postedJournal(day(40));
    const inv = String(((await sql`
      INSERT INTO supplier_invoices (company_id, invoice_number, supplier_id, invoice_date, subtotal, total_amount,
                                     created_by, status, gl_journal_entry_id)
      VALUES (${fx.companyId}::UUID, ${`R012-SI-${fx.tag.slice(-10)}`}, ${fx.supplierId}::UUID, ${day(40)}::DATE,
              100, 100, ${fx.userId}, 'approved', ${je}::UUID)
      RETURNING id`) as Row[])[0]!.id);
    const out = await inTx(fx, () => cancelSupplierInvoiceTool.handler(
      { invoice_id: inv, idempotency_key: `r012-si-${fx.tag}` }, ctx()));
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.content)).toMatch(/would precede it/);
    await sql`DELETE FROM supplier_invoices WHERE id = ${inv}::UUID`;
  });

  it('the supplier credit-note reverse route answers 400 with the reason, not a 500', async () => {
    const je = await postedJournal(day(40));
    const cn = String(((await sql`
      INSERT INTO credit_notes (company_id, type, credit_date, subtotal, total_amount, created_by, status,
                                supplier_id, gl_journal_entry_id, credit_note_number)
      VALUES (${fx.companyId}::UUID, 'supplier', ${day(40)}::DATE, 100, 100, ${fx.userId}, 'approved',
              ${fx.supplierId}::UUID, ${je}::UUID, ${`R012S-${fx.tag.slice(-12)}`})
      RETURNING id`) as Row[])[0]!.id);
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`r012-${fx.userId}@isaflow.test`}, 'admin', true)
              ON CONFLICT (id) DO NOTHING`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${fx.companyId}::UUID, ${fx.userId}, 'admin')`;
    try {
      const token = await new SignJWT({ sub: fx.userId, aal: 'aal2' })
        .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
        .sign(new TextEncoder().encode(process.env.JWT_SECRET));
      const req = request({ 'sb-access-token': token, active_company_id: fx.companyId }, 'PATCH') as never as
        { body: unknown; query: Record<string, string>; url: string };
      req.body = { id: cn, action: 'reverse' };
      req.query = {};
      req.url = '/api/accounting/supplier-credit-notes';
      const out = response();
      await supplierCreditNotesRoute(req as never, out.res as never);
      const state = out.state as { statusCode: number; body: { error?: { message?: string } } };
      expect(state.statusCode).toBe(400);
      expect(String(state.body.error?.message)).toMatch(/would precede it/);
    } finally {
      await sql`DELETE FROM company_users WHERE company_id = ${fx.companyId}::UUID`;
      await sql`DELETE FROM credit_notes WHERE id = ${cn}::UUID`;
      await sql`DELETE FROM users WHERE id = ${fx.userId}`;
    }
  });

  it('the MCP tool refuses pre-write, dry run included, when the default date lands in a closed period', async () => {
    const je = await postedJournal(day(-5));
    const before = await entryCount();
    for (const dryRun of [true, false]) {
      const out = await inTx(fx, () => reverseJournalEntryTool.handler(
        { journal_entry_id: je, dry_run: dryRun, idempotency_key: `r012-${dryRun}-${fx.tag}` }, ctx()));
      expect(out.isError, `dry_run=${dryRun}`).toBe(true);
      expect(JSON.stringify(out.content)).toMatch(/not in an open fiscal period/);
    }
    expect(await entryCount()).toBe(before);
  });
});

describeIfDb('R-012: the MCP reverse tool and an uncreatable missing period', () => {
  let fx2: Fixture;
  beforeAll(async () => {
    fx2 = await seedFixture('R012G', DATABASE_URL!);
    await sql`DELETE FROM gl_account_balances WHERE fiscal_period_id IN (
      SELECT id FROM fiscal_periods WHERE company_id = ${fx2.companyId}::UUID)`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${fx2.companyId}::UUID`;
    // One closed period ending two days ago: today is uncovered, and its fiscal
    // year cannot be created because this period overlaps that year's range.
    await sql`
      INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${fx2.companyId}::UUID, ${`R012G-${fx2.tag}`}, 1, 2150, ${day(-400)}::DATE, ${day(-2)}::DATE, 'closed')`;
  }, 120000);
  afterAll(async () => { await dropFixture(fx2); }, 120000);

  it('refuses on dry run and live alike, writing nothing (the live call used to throw FiscalPeriodOverlapError)', async () => {
    const expense = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx2.companyId}::UUID
      AND account_subtype = 'default_expense' LIMIT 1`) as Row[])[0]!.id);
    const ap = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx2.companyId}::UUID
      AND account_subtype = 'payable' LIMIT 1`) as Row[])[0]!.id);
    const je = String(((await sql`
      INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at, source)
      VALUES (${fx2.companyId}::UUID, ${`R012G-1-${fx2.tag}`}, ${day(-5)}::DATE, 'orig', 'posted', ${fx2.userId}::UUID,
              (SELECT id FROM fiscal_periods WHERE company_id = ${fx2.companyId}::UUID LIMIT 1), NOW(), 'manual')
      RETURNING id`) as Row[])[0]!.id);
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
      VALUES (${fx2.companyId}::UUID, ${je}::UUID, ${expense}::UUID, 100, 0, 'exp'),
             (${fx2.companyId}::UUID, ${je}::UUID, ${ap}::UUID, 0, 100, 'ap')`;
    const ctx2 = { companyId: fx2.companyId, userId: fx2.userId, tokenJti: 'jti-r012g', scopes: [] } as unknown as McpToolContext;
    for (const dryRun of [true, false]) {
      const out = await inTx(fx2, () => reverseJournalEntryTool.handler(
        { journal_entry_id: je, dry_run: dryRun, idempotency_key: `r012g-${dryRun}-${fx2.tag}` }, ctx2));
      expect(out.isError, `dry_run=${dryRun}`).toBe(true);
      expect(JSON.stringify(out.content)).toMatch(/not in an open fiscal period/);
    }
    const n = Number(((await sql`SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = ${fx2.companyId}::UUID`) as Row[])[0]!.n);
    expect(n).toBe(1);
  });
});
