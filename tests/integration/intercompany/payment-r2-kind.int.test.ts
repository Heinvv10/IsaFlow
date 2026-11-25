/**
 * Intercompany F, review round 2 (plan (n), MED-R1): D1's and the unsent read's cash rule, `intercompany_payment_cash_word` (migration 1031),
 * agrees with ap/settlementKind.ts (`paymentSettlementKindSql`, the rule find_double_settlements and void_payment(undo_share) use) on a table
 * of payments of B. Every rule of settlementKind is a row: 1 contra method, 2 card_line (a bank-first provisional, a live statement line on the
 * payment's journal), 3 unclassified, 4 contra by account, 5 payment. The cash word is `cash` exactly where the kind is card_line or payment,
 * with three documented differences, each fail closed or the batch's own journal standing in for a member's:
 *   - a provisional that credited NO money account is not cash (settlementKind calls any provisional a card line);
 *   - a payment with no journal and no bank account (nothing credited) is not cash (settlementKind falls through to `payment`);
 *   - a batch member is judged by its BATCH's journal (settlementKind has no journal for it and falls through to `payment`).
 * The word is read as app_user in B's session (the unsent read's caller; the function is SECURITY INVOKER).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import { paymentSettlementKindSql } from '@/modules/accounting/services/ap/settlementKind';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser } from './intercompany.helpers';
import { mirrorCleanup, wipeConnections } from './mirror.helpers';
import { bank, clearPayments, plantBatchRow, plantBill, plantPaid, plantPaymentJournal } from './allocation.helpers';
import { cashConnect, clearReceipts, co, paymentSetup, U } from './payment.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const TAG = 'IC r2 kind line';
const acc = { clearing: '', paycard: '', bare: '', expense: '' };
let conn = '';

beforeAll(async () => {
  await paymentSetup(pool);
  for (const k of Object.keys(acc) as (keyof typeof acc)[]) acc[k] = crypto.randomUUID();
  const tag = co.B.slice(0, 5);
  for (const [id, code, subtype, type] of [[acc.clearing, `CL2${tag}`, 'other_current_asset', 'asset'], [acc.paycard, `PC2${tag}`, null, 'asset'],
    [acc.bare, `NS2${tag}`, null, 'asset'], [acc.expense, `EX2${tag}`, 'operating_expense', 'expense']] as const) {
    await pool.query(
      `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active, account_subtype)
       VALUES ($1, $2, $3, $3, $5, 'debit', true, $4)`, [id, co.B, code, subtype, type]);
  }
  await pool.query('INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description) VALUES ($1, $2, DATE \'2026-09-01\', -5, $3)',
    [co.B, acc.paycard, TAG]);
}, 60000);
afterAll(async () => {
  await pool.query('DELETE FROM bank_transactions WHERE company_id = $1 AND description = $2', [co.B, TAG]);
  await clearReceipts(pool); await clearPayments(pool); await mirrorCleanup(pool);
}, 60000);
beforeEach(async () => {
  await pool.query('DELETE FROM bank_transactions WHERE company_id = $1 AND description = $2 AND bank_account_id <> $3', [co.B, TAG, acc.paycard]);
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await cashConnect(pool);
});

/** A statement line of B's bank matched to the credit line of `journal`, in `status`. */
async function lineOn(journal: string, status: string): Promise<void> {
  const jl = (await pool.query('SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND credit > 0', [journal])).rows[0].id as string;
  await pool.query(
    `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, matched_journal_line_id)
     VALUES ($1, $2, DATE '2026-09-01', -1150, $3, $4, $5)`, [co.B, bank.b, TAG, status, jl]);
}

const kindOf = async (payment: string) => String(((await sql`
  SELECT ${paymentSettlementKindSql('sp')} AS kind FROM supplier_payments sp WHERE sp.id = ${payment}::UUID AND sp.company_id = ${co.B}::UUID
`) as { kind: string }[])[0]!.kind);
const wordOf = (payment: string) => asAppUser(pool, U.b, co.B, async (q) =>
  (await q.query('SELECT public.intercompany_payment_cash_word($1, $2) AS w', [payment, co.B])).rows[0].w as string | null);

type Case = { name: string; plant: () => Promise<string>; kind: string; word: string };
const bill = async () => (await plantBill(pool, conn)).bill;
const pay = async (over: Parameters<typeof plantPaid>[2]) => (await plantPaid(pool, await bill(), over)).payment;

const CASES: Case[] = [
  { name: '1 contra method, a clearing account in the bank column', plant: () => pay({ method: 'contra', leg: acc.clearing }), kind: 'contra', word: 'not_cash' },
  { name: '1 contra method, a bank in the bank column', plant: () => pay({ method: 'contra' }), kind: 'contra', word: 'not_cash' },
  { name: '2 bank-first: the reclass credits expense, the provisional credited the bank',
    plant: async () => pay({ leg: acc.expense, provisional: await plantPaymentJournal(pool, 1150) }), kind: 'card_line', word: 'cash' },
  { name: '2* bank-first whose provisional credited a clearing account (fail closed)',
    plant: async () => pay({ leg: acc.expense, provisional: await plantPaymentJournal(pool, 1150, { leg: acc.clearing }) }), kind: 'card_line', word: 'no_money_account' },
  { name: '2 a live (matched) statement line on its journal, which credits a clearing account', plant: async () => {
    const j = await plantPaymentJournal(pool, 1150, { leg: acc.clearing });
    await lineOn(j, 'matched');
    return pay({ journal: j, leg: acc.clearing });
  }, kind: 'card_line', word: 'cash' },
  { name: '2 a reconciled statement line on its journal (bare account)', plant: async () => {
    const j = await plantPaymentJournal(pool, 1150, { leg: acc.bare });
    await lineOn(j, 'reconciled');
    return pay({ journal: j, leg: acc.bare });
  }, kind: 'card_line', word: 'cash' },
  { name: '4 an imported (not settling) statement line on its journal, which credits a clearing account', plant: async () => {
    const j = await plantPaymentJournal(pool, 1150, { leg: acc.clearing });
    await lineOn(j, 'imported');
    return pay({ journal: j, leg: acc.clearing });
  }, kind: 'contra', word: 'no_money_account' },
  { name: '3 its journal credits an account with no subtype and no statement line', plant: () => pay({ leg: acc.bare }), kind: 'unclassified', word: 'no_money_account' },
  { name: '4 its journal credits a clearing account', plant: () => pay({ leg: acc.clearing }), kind: 'contra', word: 'no_money_account' },
  { name: '4 its journal credits expense (no provisional)', plant: () => pay({ leg: acc.expense }), kind: 'contra', word: 'no_money_account' },
  { name: '5 its journal credits a bank', plant: () => pay({}), kind: 'payment', word: 'cash' },
  { name: '5 its journal credits a paycard with no subtype that holds statement lines', plant: () => pay({ leg: acc.paycard }), kind: 'payment', word: 'cash' },
  { name: '5 no journal, its bank account is a bank', plant: () => pay({ journal: false }), kind: 'payment', word: 'cash' },
  { name: '3 no journal, its bank account is bare', plant: () => pay({ journal: false, leg: acc.bare }), kind: 'unclassified', word: 'no_money_account' },
  { name: '5* no journal and no bank account (nothing credited: fail closed)', plant: async () => {
    const p = await pay({ journal: false });
    await pool.query('UPDATE supplier_payments SET bank_account_id = NULL WHERE id = $1', [p]);
    return p;
  }, kind: 'payment', word: 'no_money_account' },
  { name: '5* a batch member, the batch journal credits the bank',
    plant: async () => pay({ batch: await plantBatchRow(pool, { journal: await plantPaymentJournal(pool, 1150) }) }), kind: 'payment', word: 'cash' },
  { name: '5* a batch member, the batch journal credits a clearing account (fail closed)',
    plant: async () => pay({ batch: await plantBatchRow(pool, { journal: await plantPaymentJournal(pool, 1150, { leg: acc.clearing }) }) }), kind: 'payment', word: 'no_money_account' },
];

describe('MED-R1: the cash word agrees with settlementKind', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const p = await c.plant();
    expect({ kind: await kindOf(p), word: await wordOf(p) }).toEqual({ kind: c.kind, word: c.word });
  });

  it('every rule of settlementKind is in the table, and the word is cash only where the kind is card_line or payment', () => {
    expect(new Set(CASES.map((c) => c.kind))).toEqual(new Set(['contra', 'card_line', 'unclassified', 'payment']));
    for (const c of CASES) {
      if (c.word === 'cash') expect(['card_line', 'payment'], c.name).toContain(c.kind);
      if (c.kind === 'contra' || c.kind === 'unclassified') expect(c.word, c.name).not.toBe('cash');
      // the differences are named in the case (a starred rule), never silent
      if (c.word !== 'cash' && (c.kind === 'card_line' || c.kind === 'payment')) expect(c.name, c.name).toMatch(/^\d\*/);
    }
  });

  it('another company cannot read a word for B\'s payment (SECURITY INVOKER: RLS answers nothing, never cash)', async () => {
    const p = await pay({});
    const w = await asAppUser(pool, U.a, co.A, async (q) => (await q.query('SELECT public.intercompany_payment_cash_word($1, $2) AS w', [p, co.B])).rows[0].w);
    expect(w).not.toBe('cash');
  });
});
