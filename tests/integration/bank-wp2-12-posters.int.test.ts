// WP2 row 12, the other journal writers (round 2). Each used to call createJournalEntry with no period resolved, so a
// date no period covers or can cover posted with fiscal_period_id NULL, and a closed period left a draft behind:
//   • postProvisional, through POST /provisional/outstanding and the auto-post gate's import branch
//   • postBankTransfer
//   • createAdjustmentEntry (reconciliation adjustment, dated by the statement)
// Every refusal is CAUGHT inside the transaction and the transaction COMMITS (a request's shape), then the ledger,
// the bank line and every other table with a company_id are read back: nothing was written.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import outstanding from '../../pages/api/accounting/provisional/outstanding';
import { sweep } from '../../src/modules/accounting/services/bank/autoPostGateService';
import { postBankTransfer, BankTransferRefusedError } from '../../src/modules/accounting/services/bank/bankTransferService';
import { createAdjustmentEntry, startReconciliation } from '../../src/modules/accounting/services/bank/bankReconciliationService';
import { isBankAllocationRefusal } from '../../src/modules/accounting/services/bank/bankAllocationRefusal';
import { ClosedFiscalPeriodError } from '../../src/modules/accounting/services/gl/journalEntryPostingGuards';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { asToken, bankCompany, cleanupBankControlsA, type BankCompany } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';
beforeAll(async () => { user = await createUser(pool, tokens); });
afterAll(() => cleanupBankControlsA(pool, companies, [user]));

const NO_PERIOD = [['2001-03-15', /No fiscal period covers 2001-03-15/], ['2040-01-01', /No fiscal period covers 2040-01-01/]] as const;
const CLOSED = ['2025-06-10', /closed fiscal period/] as const;

async function co(): Promise<BankCompany> {
  const f = await bankCompany(pool, [[user, 'admin']], companies);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'R12 2025',1,2025,'2025-01-01','2025-12-31','closed')`, [f.c]);
  return f;
}
/** Row counts of every table that carries a company_id, so nothing escapes the read-back. */
async function snap(c: string): Promise<Record<string, number>> {
  const t = (await pool.query(`SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t
    ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
    WHERE c.table_schema='public' AND c.column_name='company_id'`)).rows.map((r) => r.table_name as string);
  const text = t.map((n) => `SELECT '${n}' AS t, count(*)::int AS n FROM "${n}" WHERE company_id::text = $1`).join(' UNION ALL ');
  return Object.fromEntries((await pool.query(text, [c])).rows.map((r) => [r.t as string, r.n as number]));
}
const line = async (f: BankCompany, date: string, amount: number, desc: string) => (await pool.query(
  `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,status)
   VALUES($1,$2,$3::DATE,$4,$5,'imported') RETURNING id`, [f.c, f.bank, date, amount, desc])).rows[0].id as string;
const lineStatus = async (id: string) => (await pool.query('SELECT status FROM bank_transactions WHERE id=$1', [id])).rows[0].status as string;
/** The refusal, caught INSIDE the transaction, which then commits (withAuth's shape for a 4xx). */
const committedRefusal = (f: BankCompany, fn: () => Promise<unknown>) =>
  asToken(pool, user, f.c, async () => { try { await fn(); return null; } catch (e) { return e as Error; } });

async function predictor(f: BankCompany): Promise<void> {
  const sup = (await pool.query("INSERT INTO suppliers(company_id,name,is_active) VALUES($1,'Walton Stationery',true) RETURNING id", [f.c])).rows[0].id as string;
  for (let i = 0; i < 3; i++) {
    await pool.query(`INSERT INTO supplier_coding_history (company_id, supplier_id, gl_account_id, vat_code, posted_by)
      VALUES ($1,$2,$3,'none',$4)`, [f.c, sup, f.expA, user]);
  }
  await pool.query(`INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap, updated_at)
    VALUES($1,true,0.50,0,false,0.95,2000,NOW())`, [f.c]);
}

describe('postProvisional: the open period first, a skip with the reason, nothing written', () => {
  for (const [date, text] of [...NO_PERIOD, CLOSED]) {
    it(`POST /provisional/outstanding @ ${date}`, async () => {
      const f = await co(); await predictor(f);
      const id = await line(f, date, -100, 'Walton Stationery');
      const before = await snap(f.c);
      const res = await callRoute(outstanding as never, tokens[user]!, f.c, 'POST', { bankTxIds: [id] }, '/api/accounting/provisional/outstanding');
      const row = (res.state.body as { data: { results: Array<{ journalEntryId: string | null; skipped?: string }> } }).data.results[0]!;
      expect(row.journalEntryId).toBeNull();
      expect(row.skipped ?? '').toMatch(text);
      expect(await snap(f.c)).toEqual(before);
      expect(await lineStatus(id)).toBe('imported');
    }, 60000);

    it(`auto-post gate import branch @ ${date}`, async () => {
      const f = await co(); await predictor(f);
      const id = await line(f, date, -100, 'Walton Stationery');
      const jeBefore = (await snap(f.c)).gl_journal_entries;
      const out = await asToken(pool, user, f.c, () => sweep(f.c, [id], 'import', user, user));
      expect(out.posted).toBe(0);
      expect(JSON.stringify(out.skipped)).toMatch(text);
      const after = await snap(f.c);
      expect(after.gl_journal_entries).toBe(jeBefore);
      expect(after.gl_journal_lines).toBe(0);
      expect(await lineStatus(id)).toBe('imported');
    }, 60000);
  }

  it('an open-period date still posts, on a non-null period, through both callers', async () => {
    const f = await co(); await predictor(f);
    const a = await line(f, '2026-09-01', -100, 'Walton Stationery');
    const res = await callRoute(outstanding as never, tokens[user]!, f.c, 'POST', { bankTxIds: [a] }, '/api/accounting/provisional/outstanding');
    expect((res.state.body as { data: { results: Array<{ journalEntryId: string | null }> } }).data.results[0]!.journalEntryId).toBeTruthy();
    const b = await line(f, '2026-09-02', -100, 'Walton Stationery');
    const out = await asToken(pool, user, f.c, () => sweep(f.c, [b], 'import', user, user));
    expect(out.posted).toBe(1);
    const nulls = (await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND fiscal_period_id IS NULL', [f.c])).rows[0].n;
    expect(nulls).toBe(0);
  }, 60000);
});

describe('postBankTransfer and createAdjustmentEntry: the same pre-flight, a typed refusal, nothing written', () => {
  for (const [date, text] of [...NO_PERIOD, CLOSED]) {
    it(`bank transfer @ ${date}`, async () => {
      const f = await co();
      const before = await snap(f.c);
      const err = await committedRefusal(f, () => postBankTransfer(f.c, { fromAccountId: f.bank, toAccountId: f.bank2, amount: 100, transferDate: date }, user));
      expect(err, 'a refusal is expected').toBeInstanceOf(Error);
      expect(err instanceof BankTransferRefusedError || err instanceof ClosedFiscalPeriodError, String(err)).toBe(true);
      expect(err!.message).toMatch(text);
      expect(await snap(f.c)).toEqual(before);
    }, 60000);

    it(`reconciliation adjustment dated ${date}`, async () => {
      const f = await co();
      const rec = await asToken(pool, user, f.c, () => startReconciliation(f.c, f.bank, date, 0, user));
      const before = await snap(f.c);
      const err = await committedRefusal(f, () => createAdjustmentEntry(f.c, rec.id, f.bank, f.expA, -50, 'fee', user));
      expect(err, 'a refusal is expected').toBeInstanceOf(Error);
      expect(isBankAllocationRefusal(err) || err instanceof ClosedFiscalPeriodError, String(err)).toBe(true);
      expect(err!.message).toMatch(text);
      expect(await snap(f.c)).toEqual(before);
    }, 60000);
  }

  it('an open-period transfer and adjustment still post on a non-null period', async () => {
    const f = await co();
    await asToken(pool, user, f.c, () => postBankTransfer(f.c, { fromAccountId: f.bank, toAccountId: f.bank2, amount: 100, transferDate: '2026-09-01' }, user));
    const rec = await asToken(pool, user, f.c, () => startReconciliation(f.c, f.bank, '2026-09-30', 0, user));
    await asToken(pool, user, f.c, () => createAdjustmentEntry(f.c, rec.id, f.bank, f.expA, -50, 'fee', user));
    const r = (await pool.query(`SELECT count(*)::int AS n, count(fiscal_period_id)::int AS withp FROM gl_journal_entries WHERE company_id=$1`, [f.c])).rows[0];
    expect(r.n).toBe(2);
    expect(r.withp).toBe(2);
  }, 60000);
});
