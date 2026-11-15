/**
 * Seeds for the step-6 suites (find_double_settlements, void_payment undo_share), on top of the L1 fixture: a
 * clearing account, a second expense account, a CC1, posted journals and bills that carry their own posting journal
 * (DR expense legs + VAT Input / CR AP of their total), as approveSupplierInvoice leaves them.
 */
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import type { Fixture } from './l1FifoFixture';

type Row = Record<string, unknown>;

export interface StepAccounts {
  ap: string;
  expense: string;
  expense2: string;
  vatInput: string;
  bank: string;
  clearing: string;
  cc1: string;
}

export interface Leg {
  account: string;
  debit?: number;
  credit?: number;
  vatType?: string;
  cc1Id?: string;
  /** The legacy column, as #688's backfill left it on production lines. */
  costCenterId?: string;
}

const idOf = async (fx: Fixture, subtype: string): Promise<string> => String(((await sql`
  SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = ${subtype} LIMIT 1`) as Row[])[0]!.id);

export async function seedStepAccounts(fx: Fixture): Promise<StepAccounts> {
  const acct = async (code: string, name: string, type: string, subtype: string, normal: string) => String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
    VALUES (${fx.companyId}::UUID, ${code}, ${`${name} ${fx.tag}`}, ${type}, ${subtype}, ${normal}, true)
    RETURNING id`) as Row[])[0]!.id);
  const cc1 = randomUUID();
  await sql`INSERT INTO cost_centres (id, company_id, code, name, cc_type)
            VALUES (${cc1}::UUID, ${fx.companyId}::UUID, ${`FT${fx.tag}`.slice(0, 20)}, 'Fibertime', 'cc1')`;
  return {
    ap: await idOf(fx, 'payable'),
    expense: await idOf(fx, 'default_expense'),
    expense2: await acct('6100', 'Fuel', 'expense', 'operating_expense', 'debit'),
    vatInput: await idOf(fx, 'vat_input'),
    bank: fx.bankAccountId,
    clearing: await acct('1560731', 'Bank Transfer acc - ABSA Paycards', 'asset', 'other_current_asset', 'debit'),
    cc1,
  };
}

/** A POSTED journal written directly, the shape a posted entry has. */
export async function postedJournal(fx: Fixture, date: string, legs: Leg[], reference: string | null = null): Promise<string> {
  const je = String(((await sql`
    INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by, fiscal_period_id, posted_at, reference)
    VALUES (${fx.companyId}::UUID, ${date}::DATE, ${`seed ${reference ?? ''}`}, 'posted', ${fx.userId}::UUID,
            (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID
               AND start_date <= ${date}::DATE AND end_date >= ${date}::DATE LIMIT 1), NOW(), ${reference})
    RETURNING id`) as Row[])[0]!.id);
  for (const l of legs) {
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, vat_type, cc1_id, cost_center_id)
      VALUES (${fx.companyId}::UUID, ${je}::UUID, ${l.account}::UUID, ${l.debit ?? 0}, ${l.credit ?? 0},
              ${l.vatType ?? null}, ${l.cc1Id ?? null}::UUID, ${l.costCenterId ?? null}::UUID)`;
  }
  return je;
}

/** An approved bill with its own posting journal: the debit legs, CR AP for their sum. */
export async function billWithJournal(
  fx: Fixture, a: StepAccounts, number: string, date: string, legs: Leg[], supplierId = fx.supplierId,
): Promise<{ id: string; journalId: string; total: number }> {
  const total = Math.round(legs.reduce((s, l) => s + (l.debit ?? 0), 0) * 100) / 100;
  const tax = Math.round(legs.filter((l) => l.account === a.vatInput).reduce((s, l) => s + (l.debit ?? 0), 0) * 100) / 100;
  const journalId = await postedJournal(fx, date, [...legs, { account: a.ap, credit: total }]);
  const id = String(((await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date, subtotal, tax_amount,
      total_amount, amount_paid, status, created_by, gl_journal_entry_id)
    VALUES (${fx.companyId}::UUID, ${supplierId}::UUID, ${`${number}-${fx.tag}`}, ${date}::DATE, ${date}::DATE,
            ${total - tax}, ${tax}, ${total}, 0, 'approved', ${fx.userId}::UUID, ${journalId}::UUID)
    RETURNING id`) as Row[])[0]!.id);
  return { id, journalId, total };
}

/** Posted lines of the company: Σdebit − Σcredit per account, and whether the whole ledger balances. */
export async function ledger(fx: Fixture): Promise<{ by: Record<string, number>; balanced: boolean }> {
  const rows = (await sql`
    SELECT l.gl_account_id::TEXT AS a, SUM(l.debit)::float8 AS d, SUM(l.credit)::float8 AS c
    FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE l.company_id = ${fx.companyId}::UUID AND e.company_id = ${fx.companyId}::UUID AND e.status = 'posted'
    GROUP BY l.gl_account_id`) as Row[];
  const by: Record<string, number> = {};
  let d = 0;
  let c = 0;
  for (const r of rows) {
    by[String(r.a)] = Math.round((Number(r.d) - Number(r.c)) * 100) / 100;
    d += Math.round(Number(r.d) * 100);
    c += Math.round(Number(r.c) * 100);
  }
  return { by, balanced: d === c };
}

/** What the AP subledger says is owed: Σ(total − amount_paid) over the company's live bills. */
export async function apSubledger(fx: Fixture): Promise<number> {
  const r = ((await sql`
    SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0)::float8 AS n FROM supplier_invoices
    WHERE company_id = ${fx.companyId}::UUID AND deleted_at IS NULL AND status <> 'cancelled'`) as Row[])[0]!;
  return Math.round(Number(r.n) * 100) / 100;
}

/** Everything the step-6 seeds add beyond the L1 fixture, before `dropFixture`. */
export async function dropStepExtras(fx: Fixture): Promise<void> {
  await sql`DELETE FROM mcp_tool_calls WHERE company_id = ${fx.companyId}::UUID`;
  await sql`DELETE FROM credit_note_allocations WHERE company_id = ${fx.companyId}::UUID`;
  await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
  await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID`;
  await sql`UPDATE supplier_payments SET gl_journal_entry_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
  await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
  await sql`UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
  // The lines name the CC1; they go first so it can.
  await sql`DELETE FROM gl_journal_lines WHERE company_id = ${fx.companyId}::UUID`;
  await sql`DELETE FROM cost_centres WHERE company_id = ${fx.companyId}::UUID`;
}
