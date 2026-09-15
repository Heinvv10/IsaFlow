/**
 * Round-9 review, MEDIUM-1: IFRS note 7 (Taxation) summed `debit` on VAT Input
 * and `credit` on VAT Output, each one-sided on its own account. A customer
 * credit note (DR VAT Output) and a supplier credit note (CR VAT Input) were
 * therefore never subtracted, and the signed note printed gross VAT
 * throughput: output 1 500,00 / input 200,00 / net 1 300,00 where the control
 * accounts moved 1 350 / 150 / 1 200.
 *
 * The reference is `findVatControlMovement`, which reads the same accounts under
 * the same `auto_vat_submission` exclusion and nets both sides. The note must
 * agree with it by outcome.
 *
 * Both directions of the guard:
 *   - a VAT period with NO credit notes prints exactly what it printed before
 *     the fix (the gross and the net are the same number);
 *   - the forward settlement journal is still excluded. Netting makes this
 *     predicate load-bearing: the settlement (DR Output / CR Input) would now
 *     zero both figures, where the one-sided sums missed it by direction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { noteTaxation } from '../../src/modules/accounting/services/reports/disclosureNoteGenerators';
import { findVatControlMovement } from '../../src/modules/accounting/services/reports/vatControlMovement';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/** Credit notes on both sides. */
const cnCo = crypto.randomUUID();
/** The same trade, no credit notes: the figure the fix must not move. */
const plainCo = crypto.randomUUID();

/**
 * `companies.financial_year_start` defaults to 3, so fiscal 2026 is
 * 2025-03-01..2026-02-28. Every date below sits inside it.
 */
const FISCAL_YEAR = 2026;
const START = '2025-03-01';
const END = '2026-02-28';

let entryNo = 0;

async function account(company: string, code: string, name: string, type: string, subtype: string, normal: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,
    [id, company, code, name, type, subtype, normal],
  );
  return id;
}

async function post(
  company: string, date: string, source: string,
  legs: Array<{ account: string; debit: number; credit: number }>,
): Promise<void> {
  entryNo += 1;
  const { rows } = await pool.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source, created_by)
     VALUES ($1,$2,$3,'k091f fixture','posted',$4,$1) RETURNING id`,
    [company, `K091F-${entryNo}`, date, source],
  );
  for (const leg of legs) {
    await pool.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
       VALUES ($1,$2,$3,$4,$5)`,
      [company, rows[0].id, leg.account, leg.debit, leg.credit],
    );
  }
}

/**
 * Invoice output VAT CR 1 500, bill input VAT DR 200, then the forward
 * settlement of whatever the control accounts hold (DR Output / CR Input).
 * `withCreditNotes` adds a customer credit note (DR Output 150) and a supplier
 * credit note (CR Input 50).
 */
async function seedVatBook(company: string, withCreditNotes: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO companies (id, name, is_active) VALUES ($1,$2,true) ON CONFLICT (id) DO NOTHING`,
    [company, `k091f ${company.slice(0, 8)}`],
  );
  const output = await account(company, 'V200', 'VAT output', 'liability', 'vat_output', 'credit');
  const input = await account(company, 'V100', 'VAT input', 'asset', 'vat_input', 'debit');
  const debtors = await account(company, 'D100', 'Debtors', 'asset', 'trade_receivable', 'debit');
  const creditors = await account(company, 'C100', 'Creditors', 'liability', 'trade_payable', 'credit');
  const sars = await account(company, 'S100', 'SARS VAT', 'liability', 'vat_payable', 'credit');

  await post(company, '2026-01-15', 'auto_invoice', [
    { account: output, debit: 0, credit: 1500 },
    { account: debtors, debit: 1500, credit: 0 },
  ]);
  await post(company, '2026-01-16', 'auto_supplier_invoice', [
    { account: input, debit: 200, credit: 0 },
    { account: creditors, debit: 0, credit: 200 },
  ]);
  let outputHeld = 1500;
  let inputHeld = 200;
  if (withCreditNotes) {
    await post(company, '2026-01-20', 'auto_credit_note', [
      { account: output, debit: 150, credit: 0 },
      { account: debtors, debit: 0, credit: 150 },
    ]);
    // gl_journal_entries_source_check has no supplier-credit-note value.
    await post(company, '2026-01-21', 'manual', [
      { account: input, debit: 0, credit: 50 },
      { account: creditors, debit: 50, credit: 0 },
    ]);
    outputHeld -= 150;
    inputHeld -= 50;
  }
  await post(company, '2026-02-20', 'auto_vat_submission', [
    { account: output, debit: outputHeld, credit: 0 },
    { account: input, debit: 0, credit: inputHeld },
    { account: sars, debit: 0, credit: outputHeld - inputHeld },
  ]);
}

/** Pull one amount out of the note's rendered table (en-ZA: space groups, comma decimal). */
function amount(note: Awaited<ReturnType<typeof noteTaxation>>, label: string): number {
  const row = note.tables?.[0]?.rows.find((r) => r[0]?.startsWith(label));
  expect(row, `row '${label}' missing`).toBeDefined();
  return Number(row![1]!.replace(/[\s\u00A0\u202F]/g, '').replace(',', '.'));
}

beforeAll(async () => {
  await seedVatBook(cnCo, true);
  await seedVatBook(plainCo, false);
});

afterAll(async () => {
  for (const company of [cnCo, plainCo]) {
    await pool.query(`DELETE FROM gl_journal_lines WHERE company_id = $1`, [company]);
    await pool.query(`DELETE FROM gl_journal_entries WHERE company_id = $1`, [company]);
    await pool.query(`DELETE FROM gl_accounts WHERE company_id = $1`, [company]);
    await pool.query(`DELETE FROM companies WHERE id = $1`, [company]);
  }
  await pool.end();
});

describe('IFRS note 7 nets the credit notes it was printing as gross VAT', () => {
  it('subtracts a credit note on each side', async () => {
    const note = await noteTaxation(cnCo, FISCAL_YEAR);
    expect(amount(note, 'Output VAT')).toBeCloseTo(1350, 2);
    expect(amount(note, 'Input VAT')).toBeCloseTo(150, 2);
    expect(amount(note, 'Net VAT')).toBeCloseTo(1200, 2);
  });

  it('agrees with findVatControlMovement over the same fiscal year', async () => {
    const note = await noteTaxation(cnCo, FISCAL_YEAR);
    const [m] = await findVatControlMovement(cnCo, START, END);
    expect(amount(note, 'Output VAT')).toBeCloseTo(Number(m!.gl_output), 2);
    expect(amount(note, 'Input VAT')).toBeCloseTo(Number(m!.gl_input), 2);
  });

  it('prints a period with no credit notes unchanged', async () => {
    const note = await noteTaxation(plainCo, FISCAL_YEAR);
    expect(amount(note, 'Output VAT')).toBeCloseTo(1500, 2);
    expect(amount(note, 'Input VAT')).toBeCloseTo(200, 2);
    expect(amount(note, 'Net VAT')).toBeCloseTo(1300, 2);
  });
});
