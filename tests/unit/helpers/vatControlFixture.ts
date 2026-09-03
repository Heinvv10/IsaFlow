/**
 * Shared DB fixture for the V-05 census tests.
 *
 * Three more period-bounded aggregations over the VAT control accounts
 * (`vatReconciliationService`, `disclosureNoteGenerators.noteTaxation`,
 * `workbenchService`'s VAT-estimate tile) had to grow the same
 * `je.source IS DISTINCT FROM 'auto_vat_submission'` predicate that
 * `vatReturnService` and `vatControlMovement` already carry. They each need the
 * same shaped ledger: trade VAT, plus the clearing journal vatSubmissionService
 * posts against the same two control accounts.
 *
 * Everything here WRITES, so callers must gate on `assertNotProductionDb` and
 * run inside `inRolledBackTx`.
 */
import { expect } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { getPoolForTests } from '@/lib/neon';

export const FIXTURE_USER_ID = '00000000-0000-0000-0000-0000000000aa';

type Ctx = Parameters<typeof als.run>[0];

export const ctxFor = (client: PoolClient, companyId: string): Ctx =>
  ({ client, userId: FIXTURE_USER_ID, companyId, claims: {} } as unknown as Ctx);

export interface VatFixture {
  companyId: string;
  vatOutputId: string;
  vatInputId: string;
  /** Non-VAT balancing account — must never be picked up by a VAT aggregation. */
  contraId: string;
  /** Revenue account, so GL-vs-invoice revenue comparisons have something to read. */
  revenueId: string;
}

/** A company with a vat_output, a vat_input, a revenue and a non-VAT contra account. */
export async function seedVatCompany(client: PoolClient, label: string): Promise<VatFixture> {
  const { rows: co } = await client.query<{ id: string }>(
    `INSERT INTO companies (name) VALUES ($1) RETURNING id`,
    [`V-05 census fixture — ${label}`],
  );
  const companyId = co[0]!.id;

  // is_system_account matters: systemAccountResolver only sees rows flagged
  // system, and vatSubmissionService resolves both control accounts through it.
  const account = async (
    code: string, name: string, type: string, subtype: string | null, normal: string,
    isSystem = false,
  ): Promise<string> => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO gl_accounts
         (company_id, account_code, account_name, account_type, account_subtype,
          normal_balance, is_active, is_system_account)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7) RETURNING id`,
      [companyId, code, name, type, subtype, normal, isSystem],
    );
    return rows[0]!.id;
  };

  return {
    companyId,
    vatOutputId: await account('2120', 'VAT Output', 'liability', 'vat_output', 'credit', true),
    vatInputId:  await account('1140', 'VAT Input',  'asset',     'vat_input',  'debit', true),
    contraId:    await account('2130', 'Accrued Expenses', 'liability', 'other_current_liability', 'credit'),
    revenueId:   await account('4000', 'Sales', 'revenue', 'operating_revenue', 'credit'),
  };
}

export interface FixtureLine {
  accountId: string;
  debit: number;
  credit: number;
  vatType?: string | null;
}

/** Insert a POSTED journal entry directly — no service, no fiscal period needed. */
export async function postEntry(
  client: PoolClient, companyId: string, source: string | null,
  entryDate: string, lines: FixtureLine[],
): Promise<string> {
  const debits = lines.reduce((s, l) => s + l.debit, 0);
  const credits = lines.reduce((s, l) => s + l.credit, 0);
  // A fixture that does not balance would prove nothing about a ledger service.
  expect(debits).toBeCloseTo(credits, 6);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO gl_journal_entries
       (company_id, entry_date, description, source, status, created_by)
     VALUES ($1, $2::DATE, 'V-05 census fixture', $3, 'posted', $4) RETURNING id`,
    [companyId, entryDate, source, FIXTURE_USER_ID],
  );
  const entryId = rows[0]!.id;

  for (const l of lines) {
    await client.query(
      `INSERT INTO gl_journal_lines
         (journal_entry_id, gl_account_id, company_id, debit, credit, vat_type)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [entryId, l.accountId, companyId, l.debit, l.credit, l.vatType ?? null],
    );
  }
  return entryId;
}

/** Trade VAT every case shares: R1,000 output tax on R6,666.67 of sales, R300 input tax. */
export async function seedTradeVat(
  client: PoolClient, f: VatFixture, outputDate: string, inputDate: string,
): Promise<void> {
  await postEntry(client, f.companyId, 'auto_invoice', outputDate, [
    { accountId: f.vatOutputId, debit: 0, credit: 1000, vatType: 'standard' },
    { accountId: f.revenueId,   debit: 0, credit: 6666.67, vatType: 'standard' },
    { accountId: f.contraId,    debit: 7666.67, credit: 0 },
  ]);
  await postEntry(client, f.companyId, 'auto_supplier_invoice', inputDate, [
    { accountId: f.vatInputId, debit: 300, credit: 0, vatType: 'standard' },
    { accountId: f.contraId,   debit: 0, credit: 300 },
  ]);
}

/**
 * The clearing entry `vatSubmissionService.submitVATReturn` posts: DR VAT Output,
 * CR VAT Input, and the net parked in 2130. All three lines carry vat_type NULL
 * (verified on production JE-2026-00814). Direction is the same whether the
 * period is payable or refundable — only the 2130 leg flips.
 */
export async function seedClearingEntry(
  client: PoolClient, f: VatFixture, entryDate: string,
  opts: { vatType?: string | null } = {},
): Promise<string> {
  const vatType = opts.vatType ?? null;
  return postEntry(client, f.companyId, 'auto_vat_submission', entryDate, [
    { accountId: f.vatOutputId, debit: 1000, credit: 0, vatType },
    { accountId: f.vatInputId,  debit: 0, credit: 300,  vatType },
    { accountId: f.contraId,    debit: 0, credit: 700,  vatType },
  ]);
}

/**
 * A REVERSAL of the clearing entry. `reverseJournalEntry` copies `source`
 * verbatim, so the reversal is also 'auto_vat_submission' — and it posts on the
 * opposite side of both control accounts, which is how it reaches an
 * aggregation that only sums one direction per account (noteTaxation).
 */
export async function seedClearingReversal(
  client: PoolClient, f: VatFixture, entryDate: string,
): Promise<string> {
  return postEntry(client, f.companyId, 'auto_vat_submission', entryDate, [
    { accountId: f.vatOutputId, debit: 0, credit: 1000, vatType: null },
    { accountId: f.vatInputId,  debit: 300, credit: 0,  vatType: null },
    { accountId: f.contraId,    debit: 700, credit: 0,  vatType: null },
  ]);
}

/** An OPEN fiscal period. `fiscal_periods_no_overlap` forbids overlapping ranges. */
export async function seedFiscalPeriod(
  client: PoolClient, companyId: string,
  startDate: string, endDate: string, periodNumber: number, fiscalYear: number,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO fiscal_periods
       (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
     VALUES ($1,$2,$3,$4,$5::DATE,$6::DATE,'open') RETURNING id`,
    [companyId, `P${periodNumber} ${fiscalYear}`, periodNumber, fiscalYear, startDate, endDate],
  );
  return rows[0]!.id;
}

/** Run body inside a transaction that is ALWAYS rolled back. */
export async function inRolledBackTx(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}
