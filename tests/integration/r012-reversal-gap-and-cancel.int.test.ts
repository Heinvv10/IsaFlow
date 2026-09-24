/**
 * R-012 review round 2, on isaflow_dev (the l1FifoFixture harness refuses the fixture DB).
 *
 * 1. An in-window original whose year CANNOT be created (a gap or an overlap in
 *    the company's period layout) is refused, not reversed before itself. Only
 *    a year outside the auto-create window (a typo'd 9999) keeps today.
 * 2. Cancelling a customer invoice answers the refusal with its own message
 *    (customer-invoices-detail), not the generic closed-period text.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { ReversalBeforeOriginalError } from '@/modules/accounting/services/gl/journalEntryReversalDate';
import { isDateAutoCreatable } from '@/modules/accounting/services/gl/journalEntryReversalVatRoll';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { request, response } from './mfa-impersonation-postgres.helpers';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import dismissRoute from '../../pages/api/accounting/provisional/[jeId]/dismiss';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: Fixture;
let seq = 0;
const acc: Record<string, string> = {};
const day = (offset: number): string => { const d = new Date(); d.setDate(d.getDate() + offset); return fmtDate(d); };

async function layout(ranges: Array<[string, string, 'open' | 'closed']>): Promise<void> {
  await sql`DELETE FROM gl_account_balances WHERE fiscal_period_id IN (
    SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID)`;
  await sql`DELETE FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID`;
  let n = 0;
  for (const [start, end, status] of ranges) {
    n++;
    await sql`
      INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${fx.companyId}::UUID, ${`R012B-${n}-${fx.tag}`}, ${n}, ${2200 + n}, ${start}::DATE, ${end}::DATE, ${status})`;
  }
}

async function postedJournal(date: string): Promise<string> {
  const je = String(((await sql`
    INSERT INTO gl_journal_entries
      (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at, source)
    VALUES (${fx.companyId}::UUID, ${`R012B-${++seq}-${fx.tag}`}, ${date}::DATE, 'orig', 'posted', ${fx.userId}::UUID,
            (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID
               AND start_date <= ${date}::DATE AND end_date >= ${date}::DATE LIMIT 1), NOW(), 'manual')
    RETURNING id`) as Row[])[0]!.id);
  await sql`
    INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${fx.companyId}::UUID, ${je}::UUID, ${acc.receivable!}::UUID, 100, 0, 'ar'),
           (${fx.companyId}::UUID, ${je}::UUID, ${acc.revenue!}::UUID, 0, 100, 'rev')`;
  return je;
}

const entryCount = async (): Promise<number> => Number(((await sql`
  SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Row[])[0]!.n);

describeIfDb('R-012 round 2: in-window gaps, and the invoice-cancel message', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts and reverses journals.');
    fx = await seedFixture('R012B', DATABASE_URL!);
    for (const [k, subtype] of [['receivable', 'default_expense'], ['revenue', 'payable']] as const) {
      acc[k] = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID
        AND account_subtype = ${subtype} LIMIT 1`) as Row[])[0]!.id);
    }
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`r012b-${fx.userId}@isaflow.test`}, 'admin', true)
              ON CONFLICT (id) DO NOTHING`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${fx.companyId}::UUID, ${fx.userId}, 'admin')`;
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM company_users WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${fx.companyId}::UUID`;
    await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM users WHERE id = ${fx.userId}`;
    await dropFixture(fx);
  }, 120000);

  it('refuses an in-window original whose year cannot be created, writing nothing', async () => {
    // One OPEN period up to day(10): day(40) is uncovered, in the window, and
    // not creatable because its fiscal-year range overlaps the existing period.
    await layout([[day(-400), day(10), 'open']]);
    const je = await postedJournal(day(40));
    expect(await isDateAutoCreatable(fx.companyId, day(40))).toBe(false);
    const before = await entryCount();
    const err = await inTx(fx, () => reverseJournalEntry(fx.companyId, je, fx.userId)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReversalBeforeOriginalError);
    expect(await entryCount()).toBe(before);
  });

  it('cancelling a future-dated invoice in a closed period answers 400 with the reversal\'s own reason', async () => {
    await layout([[day(-400), day(10), 'open'], [day(11), day(100), 'closed']]);
    const je = await postedJournal(day(40));
    const inv = String(((await sql`
      INSERT INTO customer_invoices (company_id, invoice_number, customer_id, invoice_date, subtotal, tax_amount,
                                     total_amount, status, created_by, gl_journal_entry_id)
      VALUES (${fx.companyId}::UUID, ${`R012B-${fx.tag.slice(-10)}`}, ${fx.customerId}::UUID, ${day(40)}::DATE,
              100, 0, 100, 'approved', ${fx.userId}, ${je}::UUID)
      RETURNING id`) as Row[])[0]!.id);
    const token = await new SignJWT({ sub: fx.userId, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const req = request({ 'sb-access-token': token, active_company_id: fx.companyId }, 'POST') as never as
      { body: unknown; query: Record<string, string>; url: string };
    req.body = { id: inv, action: 'cancel' };
    req.query = {};
    req.url = '/api/accounting/customer-invoices-detail';
    const out = response();
    await customerInvoicesDetail(req as never, out.res as never);
    const state = out.state as { statusCode: number; body: { error?: { message?: string } } };
    expect(state.statusCode).toBe(400);
    expect(String(state.body.error?.message)).toMatch(/would precede it/);
    const status = ((await sql`SELECT status FROM customer_invoices WHERE id = ${inv}::UUID`) as Row[])[0]!.status;
    expect(status).toBe('approved');
  });

  it('dismissing a future-dated provisional entry in a closed period answers 400, not 500', async () => {
    // Layout left by the previous case: day(11)..day(100) is closed.
    const je = await postedJournal(day(40));
    await sql`UPDATE gl_journal_entries SET needs_evidence = true WHERE id = ${je}::UUID`;
    const token = await new SignJWT({ sub: fx.userId, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const req = request({ 'sb-access-token': token, active_company_id: fx.companyId }, 'POST') as never as
      { body: unknown; query: Record<string, string>; url: string };
    req.body = {};
    req.query = { jeId: je };
    req.url = `/api/accounting/provisional/${je}/dismiss`;
    const out = response();
    await dismissRoute(req as never, out.res as never);
    const state = out.state as { statusCode: number; body: { error?: { message?: string } } };
    expect(state.statusCode).toBe(400);
    expect(String(state.body.error?.message)).toMatch(/would precede it/);
  });

  it('still reverses a typo\'d-year entry (9999, NULL period) by default, dated today — the real isOutsideAutoCreateWindow', async () => {
    // Today is in the open period of the current layout; 9999 is outside every window.
    const je = await postedJournal('9999-12-31');
    const r = await inTx(fx, () => reverseJournalEntry(fx.companyId, je, fx.userId));
    expect(fmtDate(r.entryDate)).toBe(day(0));
  });
});
