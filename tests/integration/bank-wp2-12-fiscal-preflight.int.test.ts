/**
 * Bank Transactions audit, WP2 row 12 — a bank allocation never posts with no fiscal period.
 *
 * `createJournalEntry` resolves the covering period and, for a date outside the window in which IsaFlow creates
 * one (fiscalPeriodAutoCreate: ten years back, two forward), stores fiscal_period_id NULL; `postJournalEntry`'s
 * closed-period check is skipped for a NULL period, so the journal POSTED outside every period-bounded report.
 * `allocateTransaction` (every arm) and `splitAllocateTransaction` now resolve the period first, before any journal is
 * written, refuse when there is none (400) or it is not open, and post on exactly the period they resolved.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { allocateTransaction, splitAllocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { isBankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';
import { ClosedFiscalPeriodError } from '@/modules/accounting/services/gl/journalEntryPostingGuards';
import type { AllocationType } from '@/modules/accounting/services/bank/bankAllocationTypes';
import { dropFixture, inTx, seedBankTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
let expense = '';
let otherBank = '';
const FAR = '2001-03-15'; // outside the auto-create window (2026 - 10 years) and covered by no period

async function journalCount(): Promise<number> {
  const [r] = (await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return Number(r!.n);
}
async function nullPeriodJournals(): Promise<number> {
  const [r] = (await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries
    WHERE company_id = ${fx.companyId}::UUID AND fiscal_period_id IS NULL`) as Record<string, unknown>[];
  return Number(r!.n);
}
async function lineStatus(tx: string): Promise<string> {
  const [r] = (await sql`SELECT status FROM bank_transactions WHERE id = ${tx}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return String(r!.status);
}
async function periodOf(journalId: string): Promise<string | null> {
  const [r] = (await sql`SELECT fiscal_period_id::TEXT AS p FROM gl_journal_entries WHERE id = ${journalId}::UUID`) as Record<string, unknown>[];
  return r!.p === null ? null : String(r!.p);
}

describeIfDb('WP2 row 12: a bank allocation never posts outside every fiscal period', () => {
  beforeAll(async () => {
    fx = await seedFixture('WP2R12', DATABASE_URL!);
    const [e] = (await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_code = '6000'`) as Record<string, unknown>[];
    expense = String(e!.id);
    otherBank = String(((await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, is_active, is_system_account)
      VALUES (${fx.companyId}::UUID, '1010', ${`Second bank ${fx.tag}`}, 'asset', 'bank', 'debit', true, false) RETURNING id`) as Record<string, unknown>[])[0]!.id);
  }, 60000);
  afterAll(async () => {
    await dropFixture(fx);
  }, 60000);

  it.each([
    ['account', -100], ['supplier', -100], ['customer', 100], ['transfer', -100],
  ] as const)('refuses a %s allocation dated where no period is or can be, before anything is written', async (allocType, amount) => {
    const tx = await seedBankTx(fx, { date: FAR, amount, description: `far ${allocType}` });
    const before = await journalCount();
    const contra = allocType === 'account' ? expense : allocType === 'transfer' ? otherBank : null;
    const entity = allocType === 'supplier' ? fx.supplierId : allocType === 'customer' ? fx.customerId : undefined;
    const err = await inTx(fx, () => allocateTransaction(fx.companyId, tx, contra, fx.userId, undefined,
      allocType as AllocationType, entity)).catch((e: unknown) => e);
    expect(isBankAllocationRefusal(err), String(err)).toBe(true);
    expect((err as Error).message).toMatch(/^No fiscal period covers 2001-03-15, and none can be created for it/);
    expect(await journalCount()).toBe(before);
    expect(await nullPeriodJournals()).toBe(0);
    expect(await lineStatus(tx)).toBe('imported');
  }, 60000);

  it('refuses a split dated where no period is or can be, before anything is written', async () => {
    const tx = await seedBankTx(fx, { date: FAR, amount: -100, description: 'far split' });
    const before = await journalCount();
    const err = await inTx(fx, () => splitAllocateTransaction(fx.companyId, tx,
      [{ contraAccountId: expense, amount: 60 }, { contraAccountId: expense, amount: 40 }], fx.userId)).catch((e: unknown) => e);
    expect(isBankAllocationRefusal(err), String(err)).toBe(true);
    expect(await journalCount()).toBe(before);
    expect(await nullPeriodJournals()).toBe(0);
    expect(await lineStatus(tx)).toBe('imported');
  }, 60000);

  it('refuses a closed period before the journal is written', async () => {
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${fx.companyId}::UUID, ${`FY25 ${fx.tag}`}, 1, 2025, '2025-01-01', '2025-12-31', 'closed')`;
    const tx = await seedBankTx(fx, { date: '2025-06-10', amount: -100, description: 'closed period' });
    const before = await journalCount();
    const err = await inTx(fx, () => allocateTransaction(fx.companyId, tx, expense, fx.userId, undefined, 'account'))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClosedFiscalPeriodError);
    expect(await journalCount()).toBe(before);
    expect(await lineStatus(tx)).toBe('imported');
  }, 60000);

  it('still posts on an open period, on exactly that period', async () => {
    const [p] = (await sql`SELECT id::TEXT AS id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID
      AND '2026-03-10'::DATE BETWEEN start_date AND end_date`) as Record<string, unknown>[];
    const tx = await seedBankTx(fx, { date: '2026-03-10', amount: -100, description: 'open period' });
    const out = await inTx(fx, () => allocateTransaction(fx.companyId, tx, expense, fx.userId, undefined, 'account'));
    expect(await periodOf(out.journalEntryId)).toBe(String(p!.id));
    const split = await seedBankTx(fx, { date: '2026-03-11', amount: -100, description: 'open split' });
    const s = await inTx(fx, () => splitAllocateTransaction(fx.companyId, split,
      [{ contraAccountId: expense, amount: 60 }, { contraAccountId: expense, amount: 40 }], fx.userId));
    expect(await periodOf(s.journalEntryId)).toBe(String(p!.id));
  }, 60000);
});
