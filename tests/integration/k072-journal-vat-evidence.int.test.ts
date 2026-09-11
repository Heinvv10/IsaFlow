/**
 * K-072 round 33: what MCP `post_journal` counts as a captured draft's VAT,
 * and what VAT the captured document evidences. Proved against the DB:
 *
 *   - HIGH-1 (r34): "no VAT read" is evidence of none ONLY where the document
 *     says no VAT applies and prints no VAT number. A page printing no tax word
 *     is not enough, and a missed `B.T.W.`/`VAT INCL`/`VAl` is refused;
 *   - LOW-1: the draft's VAT is the net debit on EVERY tax account — VAT on a
 *     `vat_output` debit, on a generic `tax` account, or on a NULL-subtype
 *     "VAT Payable" is counted, so an unread document refuses it; a CREDIT to
 *     VAT Input counts negative;
 *   - a read VAT folded into the expense is consistent only where s17(2)(a)
 *     folds it: every other debit on an account that denies input VAT. The
 *     vendor's name excuses nothing (r34: `Spurway Steel`, `Mr Doors`);
 *   - the one-cent tolerance, both sides.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als } from '@/lib/als';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { postJournalTool } from '@/lib/mcp/tools/writeJournals';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const ctx = { userId: admin, companyId: company, scopes: ['write:journals', 'write:post'], tokenJti: 'jti', oauthAppId: null } as McpToolContext;
const A: Record<string, string> = {};

const NO_TAX_TEXT = 'K072 Garden\nGarden service 1000.00\nAmount Due 1000.00';
const DECLARED = 'K072 Garden\nNot VAT registered\nGarden service 1000.00\nAmount Due 1000.00';
const doc = (over: Record<string, unknown>) => ({
  documentType: 'receipt', vendorName: 'K072 Garden', date: '2026-04-10', totalAmount: 1000, subtotal: null,
  vatAmount: null, lineItems: [], rawText: DECLARED, confidence: 0.9, warnings: [], extractionMethod: 'vlm', ...over,
});

async function seed(extracted: Record<string, unknown>): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status)
     VALUES($1,$2,$3,'application/pdf','receipt',$4::jsonb,'pending')`, [id, company, `k072-${id}.pdf`, JSON.stringify(extracted)],
  );
  return id;
}

/** A capture-linked draft journal with these [account, debit, credit] lines. */
async function draft(documentId: string, lines: Array<[string, number, number]>): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,source,status,created_by,source_document_id)
     VALUES($1,$2,'2026-04-10','Receipt: r33','auto_invoice','draft',$3,$4) RETURNING id`,
    [company, `K072-J-${crypto.randomUUID().slice(0, 8)}`, admin, documentId],
  );
  for (const [account, debit, credit] of lines) {
    await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit,description)
      VALUES($1,$2,$3,$4,$5,'x')`, [rows[0].id, company, A[account], debit, credit]);
  }
  return rows[0].id as string;
}

async function post(journalId: string): Promise<{ refused: boolean; status: string; text: string }> {
  const client: PoolClient = await pool.connect();
  await client.query('BEGIN');
  let out: McpToolResult;
  try {
    out = await als.run({ client, userId: admin, companyId: company, claims: {} } as never,
      () => postJournalTool.handler({ journal_id: journalId, idempotency_key: crypto.randomUUID() }, ctx));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
  const { rows } = await pool.query('SELECT status FROM gl_journal_entries WHERE id=$1', [journalId]);
  return { refused: out.isError === true && /not the VAT read off the captured document/.test(out.content[0]!.text),
    status: rows[0].status as string, text: out.content[0]!.text };
}

async function account(key: string, code: string, name: string, type: string, subtype: string | null, normal: string, denied = false) {
  const { rows } = await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,
       is_system_account,vat_input_denied) VALUES($1,$2,$3,$4,$5,$6,true,$7,$8) RETURNING id`,
    [company, code, name, type, subtype, normal, subtype !== null, denied],
  );
  A[key] = rows[0].id as string;
}

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K072 r33 journal VAT evidence')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [company, admin, 'admin']);
  await pool.query(`INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
    VALUES($1,'K072 FY',1,2026,'2026-01-01','2026-12-31','open')`, [company]);
  await account('exp', '6000', 'K072 Expense', 'expense', 'default_expense', 'debit');
  await account('ent', '5600', 'K072 Entertainment', 'expense', null, 'debit', true);
  await account('bank', '1000', 'K072 Bank', 'asset', 'bank', 'debit');
  await account('in', '1300', 'K072 Input', 'asset', 'vat_input', 'debit');
  await account('out', '2100', 'K072 Output', 'liability', 'vat_output', 'credit');
  await account('tax', '1310', 'K072 Tax asset', 'asset', 'tax', 'debit');
  await account('payable', '2110', 'VAT Payable', 'liability', null, 'credit');
  clearSystemAccountCache(company);
});

afterAll(async () => {
  try {
    for (const q of ['DELETE FROM gl_journal_lines WHERE company_id=$1', 'DELETE FROM gl_journal_entries WHERE company_id=$1',
      'DELETE FROM captured_documents WHERE company_id=$1',
      'DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)',
      'DELETE FROM gl_accounts WHERE company_id=$1', 'DELETE FROM fiscal_periods WHERE company_id=$1',
      'DELETE FROM company_users WHERE company_id=$1', 'DELETE FROM companies WHERE id=$1',
    ]) await pool.query(q, [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

const NONE: Array<[string, number, number]> = [['exp', 1000, 0], ['bank', 0, 1000]];

it('HIGH-1: none read is none only where the document says so; everything else is refused a draft claiming none', async () => {
  expect(await post(await draft(await seed(doc({})), NONE))).toMatchObject({ refused: false, status: 'posted' });
  const refusedTexts = ['Brits Hardeware\nB.T.W. Nr 4123450000\nSement 50kg 1000.00\nTOTAAL 1000.00\nB.T.W. 130.43',
    ...['B T W 130.43', 'V A T 130.43', 'VAl 130.43', 'V4T 130.43', 'Incl. 130.43', 'Incl 15 persent 130.43', 'VAT INCL 130.43']
      .map((tail) => `Brits Hardeware\nFAKTUUR\nSement 50kg 1000.00\nTOTAAL 1000.00\n${tail}`),
    NO_TAX_TEXT, `${DECLARED}\nVAT No 4123450000`, ''];
  for (const rawText of refusedTexts) {
    expect(await post(await draft(await seed(doc({ rawText })), NONE)), rawText).toMatchObject({ refused: true, status: 'draft' });
  }
});

it('LOW-1: VAT on a vat_output debit, a generic tax account or a NULL-subtype "VAT Payable" is the draft\'s VAT', async () => {
  for (const vatAccount of ['out', 'tax', 'payable', 'in']) {
    const lines: Array<[string, number, number]> = [['exp', 869.57, 0], [vatAccount, 130.43, 0], ['bank', 0, 1000]];
    expect(await post(await draft(await seed(doc({})), lines)), vatAccount).toMatchObject({ refused: true, status: 'draft' });
  }
  // A credit to VAT Input nets negative against a document showing none.
  const reversal: Array<[string, number, number]> = [['exp', 1130.43, 0], ['in', 0, 130.43], ['bank', 0, 1000]];
  expect(await post(await draft(await seed(doc({})), reversal))).toMatchObject({ refused: true });
});

it('a read VAT folded into the expense posts only on an account that denies input VAT — never by vendor name', async () => {
  const read = { subtotal: 869.57, vatAmount: 130.43, rawText: 'K072\nService 1000.00\nTOTAL 1000.00\nVAT 130.43' };
  expect(await post(await draft(await seed(doc(read)), [['ent', 1000, 0], ['bank', 0, 1000]]))).toMatchObject({ status: 'posted' });
  // A real Spur receipt still posts where it is booked: on the entertainment account.
  const spur = { ...read, vendorName: 'Spur Linden' };
  expect(await post(await draft(await seed(doc(spur)), [['ent', 1000, 0], ['bank', 0, 1000]]))).toMatchObject({ status: 'posted' });
  // r34 MEDIUM-1: the name alone excuses nothing — the reviewer's two DB shapes, and Spur itself, on an ordinary account.
  for (const vendorName of ['Spurway Steel', 'Mr Doors Brits', 'Spur Linden', 'K072']) {
    expect(await post(await draft(await seed(doc({ ...read, vendorName })), NONE)), vendorName).toMatchObject({ refused: true, status: 'draft' });
  }
  // Half denied is not denied: every other debit must be on a denying account.
  const mixed: Array<[string, number, number]> = [['ent', 500, 0], ['exp', 500, 0], ['bank', 0, 1000]];
  expect(await post(await draft(await seed(doc(read)), mixed))).toMatchObject({ refused: true });
});

it('the tolerance is one cent either way', async () => {
  const read = { subtotal: 869.57, vatAmount: 130.43, rawText: 'K072\nService 1000.00\nTOTAL 1000.00\nVAT 130.43' };
  for (const [vat, refused] of [[130.44, false], [130.42, false], [130.45, true], [130.41, true]] as const) {
    const lines: Array<[string, number, number]> = [['exp', Math.round((1000 - vat) * 100) / 100, 0], ['in', vat, 0], ['bank', 0, 1000]];
    expect(await post(await draft(await seed(doc(read)), lines)), String(vat)).toMatchObject({ refused });
  }
});
