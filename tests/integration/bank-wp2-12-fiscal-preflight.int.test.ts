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
import { FiscalPeriodLockTimeoutError } from '@/modules/accounting/services/gl/periodCloseErrors';
import { allocationPeriodFor } from '@/modules/accounting/services/bank/bankAllocationPeriod';
import { isBankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';
import { ClosedFiscalPeriodError } from '@/modules/accounting/services/gl/journalEntryPostingGuards';
import type { AllocationType } from '@/modules/accounting/services/bank/bankAllocationTypes';
import { dropFixture, inTx, runOn, seedBankTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
let expense = '';
let otherBank = '';
const FAR = '2001-03-15'; // outside the auto-create window (2026 - 10 years) and covered by no period

/**
 * A request's shape (withAuth): the refusal is CAUGHT inside the transaction and the transaction COMMITS, so whatever
 * the failing call had already written survives to be counted. `inTx` rolls back on a throw, which made every
 * "nothing was written" assertion vacuous.
 */
async function refusedAndCommitted(fn: () => Promise<unknown>): Promise<unknown> {
  const c = await fx.pool.connect();
  await c.query('BEGIN');
  let err: unknown;
  try {
    await runOn(fx, c, fn);
  } catch (e) {
    err = e;
  }
  await c.query('COMMIT');
  c.release();
  return err;
}
async function written(): Promise<Record<string, number>> {
  const [r] = (await sql`SELECT
    (SELECT COUNT(*) FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID)::int AS journals,
    (SELECT COUNT(*) FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id = ${fx.companyId}::UUID)::int AS lines,
    (SELECT COUNT(*) FROM supplier_payments WHERE company_id = ${fx.companyId}::UUID)::int AS supplier_payments,
    (SELECT COUNT(*) FROM customer_payments WHERE company_id = ${fx.companyId}::UUID)::int AS customer_payments,
    (SELECT COUNT(*) FROM bank_transactions WHERE company_id = ${fx.companyId}::UUID
      AND (matched_journal_line_id IS NOT NULL OR status <> 'imported'))::int AS touched_lines`) as Record<string, unknown>[];
  return Object.fromEntries(Object.entries(r!).map(([k, v]) => [k, Number(v)]));
}
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
    const before = await written();
    const contra = allocType === 'account' ? expense : allocType === 'transfer' ? otherBank : null;
    const entity = allocType === 'supplier' ? fx.supplierId : allocType === 'customer' ? fx.customerId : undefined;
    const err = await refusedAndCommitted(() => allocateTransaction(fx.companyId, tx, contra, fx.userId, undefined,
      allocType as AllocationType, entity));
    expect(isBankAllocationRefusal(err), String(err)).toBe(true);
    expect((err as Error).message).toMatch(/^No fiscal period covers 2001-03-15, and none can be created for it/);
    expect(await written()).toEqual(before);
    expect(await nullPeriodJournals()).toBe(0);
    expect(await lineStatus(tx)).toBe('imported');
  }, 60000);

  it('refuses a split dated where no period is or can be, before anything is written', async () => {
    const tx = await seedBankTx(fx, { date: FAR, amount: -100, description: 'far split' });
    const before = await written();
    const err = await refusedAndCommitted(() => splitAllocateTransaction(fx.companyId, tx,
      [{ contraAccountId: expense, amount: 60 }, { contraAccountId: expense, amount: 40 }], fx.userId));
    expect(isBankAllocationRefusal(err), String(err)).toBe(true);
    expect(await written()).toEqual(before);
    expect(await nullPeriodJournals()).toBe(0);
    expect(await lineStatus(tx)).toBe('imported');
  }, 60000);

  it('refuses a closed period before the journal is written', async () => {
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${fx.companyId}::UUID, ${`FY25 ${fx.tag}`}, 1, 2025, '2025-01-01', '2025-12-31', 'closed')`;
    const tx = await seedBankTx(fx, { date: '2025-06-10', amount: -100, description: 'closed period' });
    const before = await written();
    const err = await refusedAndCommitted(() => allocateTransaction(fx.companyId, tx, expense, fx.userId, undefined, 'account'));
    expect(err).toBeInstanceOf(ClosedFiscalPeriodError);
    expect(await written()).toEqual(before);
    expect(await lineStatus(tx)).toBe('imported');
  }, 60000);

  it('a gap beside closed periods in a year says so, never "create the period first"', async () => {
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${fx.companyId}::UUID, ${`Q1 24 ${fx.tag}`}, 1, 2024, '2024-01-01', '2024-03-31', 'closed')`;
    const tx = await seedBankTx(fx, { date: '2024-06-10', amount: -100, description: 'gap beside closed' });
    const before = await written();
    const err = await refusedAndCommitted(() => allocateTransaction(fx.companyId, tx, expense, fx.userId, undefined, 'account'));
    expect(err).toBeInstanceOf(ClosedFiscalPeriodError);
    expect((err as Error).message).toMatch(/holds closed or locked periods/);
    expect((err as Error).message).not.toMatch(/Create the period first/);
    expect(await written()).toEqual(before);
  }, 60000);

  it('asks the period LAST: another refusal on the same far-dated line wins, and nothing is written', async () => {
    const [ap] = (await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'payable' LIMIT 1`) as Record<string, unknown>[];
    expect(ap, 'the fixture needs an AP control account').toBeTruthy();
    const tx = await seedBankTx(fx, { date: FAR, amount: -100, description: 'far onto AP control' });
    const before = await written();
    const err = await refusedAndCommitted(() => allocateTransaction(fx.companyId, tx, String(ap!.id), fx.userId, undefined, 'account'));
    expect(err, 'a refusal is expected').toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/No fiscal period covers/);
    expect(await written()).toEqual(before);
  }, 60000);

  it('holds the period row FOR SHARE until the request ends, so a concurrent close (FOR NO KEY UPDATE) cannot land between check and post', async () => {
    const [p] = (await sql`SELECT id::TEXT AS id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID
      AND '2026-03-10'::DATE BETWEEN start_date AND end_date`) as Record<string, unknown>[];
    const a = await fx.pool.connect();
    const b = await fx.pool.connect();
    try {
      await a.query('BEGIN');
      await runOn(fx, a, () => allocationPeriodFor(fx.companyId, '2026-03-10'));
      await b.query('BEGIN');
      const closer = await b.query('SELECT id FROM fiscal_periods WHERE id = $1::UUID FOR NO KEY UPDATE NOWAIT', [p!.id])
        .then(() => null, (e: { code?: string }) => e);
      expect(closer?.code, 'the closer must find the period row locked').toBe('55P03');
    } finally {
      await b.query('ROLLBACK').catch(() => undefined);
      await a.query('ROLLBACK').catch(() => undefined);
      a.release(); b.release();
    }
  }, 60000);

  it('a period row held by a closer (FOR NO KEY UPDATE) is a bounded wait, then a typed busy refusal — never a stall', async () => {
    const [p] = (await sql`SELECT id::TEXT AS id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID
      AND '2026-03-10'::DATE BETWEEN start_date AND end_date`) as Record<string, unknown>[];
    const closer = await fx.pool.connect();
    const alloc = await fx.pool.connect();
    try {
      await closer.query('BEGIN');
      await closer.query('SELECT id FROM fiscal_periods WHERE id = $1::UUID FOR NO KEY UPDATE', [p!.id]);
      await alloc.query('BEGIN');
      await alloc.query("SET LOCAL lock_timeout = '300ms'"); // the caller's own, tighter than the 5 s budget: honoured
      const t0 = Date.now();
      const err = await runOn(fx, alloc, () => allocationPeriodFor(fx.companyId, '2026-03-10')).then(() => null, (e: unknown) => e);
      expect(err, String(err)).toBeInstanceOf(FiscalPeriodLockTimeoutError);
      expect((err as Error).message).toMatch(/retry in a moment/);
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      await alloc.query('ROLLBACK').catch(() => undefined);
      await closer.query('ROLLBACK').catch(() => undefined);
      alloc.release(); closer.release();
    }
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
