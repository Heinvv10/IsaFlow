/**
 * Fixtures for vat-displayed-differs-plan.int.test.ts: companies, journals and bank transactions inserted on the
 * caller's client (the caller owns BEGIN / ROLLBACK).
 */
import type { PoolClient } from 'pg';

export const AS_AT = '2026-09-30';
export const USER = '00000000-0000-0000-0000-0000000000bb';

interface Accounts { bank: string; vatIn: string; vatOut: string; opex: string }

export async function seedCompany(client: PoolClient, name: string): Promise<{ companyId: string; acct: Accounts }> {
  const { rows: [co] } = await client.query<{ id: string }>(
    `INSERT INTO companies (name) VALUES ($1) RETURNING id`, [name],
  );
  const companyId = co!.id;
  const account = async (code: string, accName: string, type: string, subtype: string): Promise<string> => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [companyId, code, accName, type, subtype, type === 'asset' || type === 'expense' ? 'debit' : 'credit'],
    );
    return rows[0]!.id;
  };
  return {
    companyId,
    acct: {
      bank: await account('1000', 'Bank', 'asset', 'bank'),
      vatIn: await account('1200', 'VAT Input', 'asset', 'vat_input'),
      vatOut: await account('2200', 'VAT Output', 'liability', 'vat_output'),
      opex: await account('6000', 'Office Costs', 'expense', 'operating_expense'),
    },
  };
}

/** One journal (status draft: the check does not read status, and posted journals fire balance triggers per line). */
async function journal(
  client: PoolClient, companyId: string, no: string, date: string,
  lines: Array<[string, number, number]>,
): Promise<{ jeId: string; lineIds: string[] }> {
  const { rows: [je] } = await client.query<{ id: string }>(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by)
     VALUES ($1,$2,$3,$5,'auto_bank_recon','draft',$4) RETURNING id`,
    // $2 must not double as the description: one parameter, one deduced type.
    [companyId, no, date, USER, no],
  );
  const lineIds: string[] = [];
  for (const [acct, debit, credit] of lines) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [companyId, je!.id, acct, debit, credit],
    );
    lineIds.push(rows[0]!.id);
  }
  return { jeId: je!.id, lineIds };
}

async function bankTx(
  client: PoolClient, companyId: string, bankAcct: string, ref: string, date: string,
  matched: string | null, vatCode: string | null, description = ref,
) {
  await client.query(
    `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description,
       reference, status, matched_journal_line_id, suggested_vat_code)
     VALUES ($1,$2,$3,-100,$4,$5,'imported',$6,$7)`,
    [companyId, bankAcct, date, description, ref, matched, vatCode],
  );
}

/** Every shape the predicate has to get right, with distinct amounts so ordering is unambiguous. */
export async function seedEdgeCases(client: PoolClient): Promise<string> {
  const { companyId, acct } = await seedCompany(client, 'VAT plan fixture');
  const a = acct;
  // 15.00 of input VAT, NULL code (how production rows look).
  const j1 = await journal(client, companyId, 'J1', '2026-06-10', [[a.opex, 100, 0], [a.vatIn, 15, 0], [a.bank, 0, 115]]);
  await bankTx(client, companyId, a.bank, 'BT-NULL', '2026-06-09', j1.lineIds[2]!, null);
  // Two VAT lines in one journal: one bank transaction yields TWO rows (30 and 20.50).
  const j2 = await journal(client, companyId, 'J2', '2026-06-11', [
    [a.opex, 100, 0], [a.vatIn, 30, 0], [a.vatOut, 0, 20.5], [a.bank, 0, 109.5],
  ]);
  await bankTx(client, companyId, a.bank, 'BT-TWO-VAT', '2026-06-11', j2.lineIds[3]!, 'no_vat');
  // The code says standard: displayed and posted agree, excluded.
  const j3 = await journal(client, companyId, 'J3', '2026-06-12', [[a.opex, 100, 0], [a.vatIn, 99.99, 0], [a.bank, 0, 199.99]]);
  await bankTx(client, companyId, a.bank, 'BT-STANDARD', '2026-06-12', j3.lineIds[2]!, 'standard');
  // Dated after as_at, excluded.
  const j4 = await journal(client, companyId, 'J4', '2026-10-05', [[a.opex, 100, 0], [a.vatIn, 77, 0], [a.bank, 0, 177]]);
  await bankTx(client, companyId, a.bank, 'BT-LATE', '2026-10-05', j4.lineIds[2]!, null);
  // A VAT line with no amount (debit and credit both 0), excluded. The columns are numeric(15,2),
  // so the 0.005 floor in the SQL cannot be told from `> 0` by any stored value.
  const j5 = await journal(client, companyId, 'J5', '2026-06-13', [[a.opex, 100, 0], [a.vatIn, 0, 0], [a.bank, 0, 100]]);
  await bankTx(client, companyId, a.bank, 'BT-ZERO-VAT', '2026-06-13', j5.lineIds[2]!, null);
  // Not matched to any journal line, excluded.
  await bankTx(client, companyId, a.bank, 'BT-UNMATCHED', '2026-06-14', null, null);
  // A journal with no VAT line at all, excluded.
  const j6 = await journal(client, companyId, 'J6', '2026-06-15', [[a.opex, 100, 0], [a.bank, 0, 100]]);
  await bankTx(client, companyId, a.bank, 'BT-NO-VAT-LINE', '2026-06-15', j6.lineIds[1]!, null);
  // One more hit, dated exactly on as_at (the boundary is inclusive); empty reference so the label falls back to the description.
  const j7 = await journal(client, companyId, 'J7', '2026-06-16', [[a.opex, 100, 0], [a.vatIn, 7.25, 0], [a.bank, 0, 107.25]]);
  await bankTx(client, companyId, a.bank, '', AS_AT, j7.lineIds[2]!, null, 'only a description');
  // Six ties at 12.00, so a missing `, id` tie-break shows as an unsorted sample (1 chance in 720 of sorting by luck).
  for (let n = 1; n <= 6; n++) {
    const jt = await journal(client, companyId, `JT${n}`, '2026-06-17', [[a.opex, 100, 0], [a.vatIn, 12, 0], [a.bank, 0, 112]]);
    await bankTx(client, companyId, a.bank, `BT-TIE-${n}`, '2026-06-17', jt.lineIds[2]!, null);
  }
  // The VAT-bearing journal belongs to ANOTHER company, whose own bank transaction is its hit, not ours.
  const other = await seedCompany(client, 'VAT plan other tenant');
  const jo = await journal(client, other.companyId, 'JO', '2026-06-10', [
    [other.acct.opex, 100, 0], [other.acct.vatIn, 500, 0], [other.acct.bank, 0, 600],
  ]);
  await bankTx(client, other.companyId, other.acct.bank, 'BT-OTHER', '2026-06-10', jo.lineIds[2]!, null);
  // Cross-tenant joins. Our bank transaction matched to the OTHER company's line (guard `jl.company_id = bt.company_id`):
  await bankTx(client, companyId, a.bank, 'BT-MATCHED-ACROSS', '2026-06-18', jo.lineIds[2]!, null);
  // and ANOTHER company's VAT line sitting in OUR journal (guard `vl.company_id = bt.company_id`, with its own account):
  const jx = await journal(client, companyId, 'JX', '2026-06-19', [[a.opex, 100, 0], [a.bank, 0, 100]]);
  await client.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,41,0)`,
    [other.companyId, jx.jeId, other.acct.vatIn],
  );
  await bankTx(client, companyId, a.bank, 'BT-FOREIGN-VAT-LINE', '2026-06-19', jx.lineIds[1]!, null);
  // The mirror of both: a line stamped with OUR company inside the other company's journal, which our matched bank
  // transaction reaches only if `jl.company_id = bt.company_id` is missing.
  // (`ga.company_id = vl.company_id` has no such case: gl_journal_lines_account_company_fk refuses a line on another company's account.)
  await client.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,33,0)`,
    [companyId, jo.jeId, a.vatIn],
  );
  return companyId;
}

/** A tenant of the size that timed out in production: 1,546 matched bank transactions, ~5,000 lines, 150 accounts. */
export async function seedUnseenTenant(client: PoolClient, name: string): Promise<{ companyId: string; expected: number }> {
  const { companyId, acct } = await seedCompany(client, name);
  await client.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance)
     SELECT $1, (7000 + g)::text, 'Expense ' || g, 'expense', 'operating_expense', 'debit' FROM generate_series(1, 146) g`,
    [companyId],
  );
  await client.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by)
     SELECT $1, 'U' || g, DATE '2026-01-01' + (g % 200), 'unseen ' || g, 'auto_bank_recon', 'draft', $2
     FROM generate_series(1, 2100) g`,
    [companyId, USER],
  );
  // Journals 1..1546 are bank-matched: bank + expense, plus a VAT line on every ninth.
  await client.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
     SELECT $1, je.id, $2, 0, 115 FROM gl_journal_entries je
     WHERE je.company_id = $1 AND substring(je.entry_number from 2)::INT <= 1546`,
    [companyId, acct.bank],
  );
  await client.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
     SELECT $1, je.id, $2, 100, 0 FROM gl_journal_entries je WHERE je.company_id = $1`,
    [companyId, acct.opex],
  );
  await client.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
     SELECT $1, je.id, $2, 15 + (n % 7), 0
     FROM (SELECT id, substring(entry_number from 2)::INT AS n FROM gl_journal_entries WHERE company_id = $1) je
     WHERE je.n <= 1546 AND je.n % 9 = 0`,
    [companyId, acct.vatIn],
  );
  // Filler lines on the 554 non-bank journals.
  await client.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
     SELECT $1, je.id, $2, 0, 100 FROM gl_journal_entries je
     WHERE je.company_id = $1 AND substring(je.entry_number from 2)::INT > 1546`,
    [companyId, acct.bank],
  );
  await client.query(
    `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description,
       reference, status, matched_journal_line_id, suggested_vat_code)
     SELECT $1, $2, DATE '2026-01-01' + (substring(je.entry_number from 2)::INT % 200), -115, 'tx', 'ref-' || je.entry_number,
            'imported', jl.id, NULL
     FROM gl_journal_entries je
     JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.gl_account_id = $2
     WHERE je.company_id = $1 AND substring(je.entry_number from 2)::INT <= 1546`,
    [companyId, acct.bank],
  );
  return { companyId, expected: Math.floor(1546 / 9) };
}
