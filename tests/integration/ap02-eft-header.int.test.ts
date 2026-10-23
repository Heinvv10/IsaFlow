/**
 * AP-02 (audit 2026-10-18) — the EFT file header. eft-generate read the
 * originating account, branch, company name and action date from columns
 * supplier_payment_batches does not have (company_name, bank_account_number,
 * bank_branch_code, payment_date), so every file went out as account
 * 00000000000, branch 000000, dated today instead of batch_date.
 *
 * The header now comes from the batch's paying bank GL account
 * (gl_accounts.bank_account_number / bank_branch_code — what the Bank Accounts
 * page edits), companies.name and batch_date::text. A batch whose bank account
 * is missing, foreign, or without number/branch is refused: never zeros.
 * AP-36: a payee with no (or a malformed) branch code is refused, not sent as 000000.
 *
 * Judged by the generated file's own header line, for every bank format.
 * Disposable DB only (assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import eftGenerate from '../../pages/api/accounting/eft-generate';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import { cleanupPr5, payCompany, plantApprovedBatch } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';

const ACCOUNT = '40712345678';
const BRANCH = '198765';
const NAME = 'Header Test Holdings';

beforeAll(async () => {
  user = await createUser(pool, tokens);
});
afterAll(() => cleanupPr5(pool, companies, [user])); // ends the pool

async function fixture(
  bankDetails: { number: string | null; branch: string | null } = { number: ACCOUNT, branch: BRANCH }, amounts?: number[],
) {
  const { company: c, bank } = await payCompany(pool, [[user, 'admin']], companies);
  await pool.query('UPDATE companies SET name = $2 WHERE id = $1', [c, NAME]);
  await pool.query('UPDATE gl_accounts SET bank_account_number = $2, bank_branch_code = $3 WHERE id = $1',
    [bank, bankDetails.number, bankDetails.branch]);
  return { c, bank, batch: await plantApprovedBatch(pool, c, user, bank, amounts) };
}

const generate = (c: string, batchId: string, bank = 'fnb') =>
  callRoute(eftGenerate, tokens[user]!, c, 'POST', { batchId, bank }, '/api/accounting/eft-generate');
const headerOf = (res: Parameters<typeof dataOf>[0]) => dataOf<{ content: string }>(res).content.split('\n')[0]!;

describe('eft-generate header (AP-02)', () => {
  // batch_date is 2026-09-01 (plantApprovedBatch): never today, so a today-fallback is visible.
  it.each(['standard_bank', 'fnb', 'absa', 'nedbank', 'capitec'])(
    '%s: the header carries the paying bank account, its branch, companies.name and batch_date',
    async (bank) => {
      const { c, batch } = await fixture();
      const res = await generate(c, batch.id, bank);
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
      const header = headerOf(res);
      expect(header).toContain(ACCOUNT);
      expect(header).toContain(BRANCH);
      expect(header).toContain(NAME);
      expect(header).toContain('260901');
      expect(header).not.toContain('00000000000');
      expect(dataOf<{ filename: string }>(res).filename).toContain('2026-09-01');
    },
  );

  it('standard_bank: the exact header record (branch, account, name, YYMMDD, reference, count)', async () => {
    const { c, batch } = await fixture();
    const header = headerOf(await generate(c, batch.id, 'standard_bank'));
    expect(header.slice(0, 1 + 6 + 11)).toBe(`H${BRANCH}${ACCOUNT}`);
    expect(header.slice(18, 48)).toBe(NAME.padEnd(30, ' '));
    expect(header.slice(48, 54)).toBe('260901');
    expect(header.slice(54, 74)).toBe(batch.number.padEnd(20, ' ').slice(0, 20));
    expect(header.slice(74)).toBe('000002');
  });

  it('the action date follows the batch: 2027-01-01 is sent as 270101', async () => {
    const { c, batch } = await fixture();
    const { rows: [d] } = await pool.query(
      "UPDATE supplier_payment_batches SET batch_date = DATE '2027-01-01' WHERE id = $1 RETURNING batch_date::text AS d", [batch.id]);
    expect(d.d).toBe('2027-01-01');
    const header = headerOf(await generate(c, batch.id, 'standard_bank'));
    expect(header.slice(48, 54)).toBe('270101');
  });

  it.each([
    ['no account number', { number: null, branch: BRANCH }, /account number/i],
    ['a blank account number', { number: '  ', branch: BRANCH }, /account number/i],
    ['no branch code', { number: ACCOUNT, branch: null }, /branch code/i],
    ['a malformed branch code', { number: ACCOUNT, branch: '25' }, /branch code/i],
  ])('refuses 400 when the bank account has %s, and emits no file', async (_label, details, message) => {
    const { c, batch } = await fixture(details);
    const res = await generate(c, batch.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(messageOf(res) + JSON.stringify(res.state.body)).toMatch(message);
    expect(JSON.stringify(res.state.body)).not.toContain('content');
  });

  it('refuses 400 a batch with no bank account', async () => {
    const { c, batch } = await fixture();
    await pool.query('UPDATE supplier_payment_batches SET bank_account_id = NULL WHERE id = $1', [batch.id]);
    const res = await generate(c, batch.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(JSON.stringify(res.state.body)).not.toContain('content');
  });

  it("refuses 400 a batch whose bank account is another company's, though it carries a number", async () => {
    const mine = await fixture({ number: null, branch: null });
    const other = await fixture();
    await pool.query('UPDATE supplier_payment_batches SET bank_account_id = $2 WHERE id = $1', [mine.batch.id, other.bank]);
    const res = await generate(mine.c, mine.batch.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(JSON.stringify(res.state.body)).not.toContain(ACCOUNT);
  });
});

describe('eft-generate payee branch (AP-36)', () => {
  it.each(['', '  ', '25065', '2506-5'])('refuses 400 a payee whose branch code is %j, not 000000', async (branch) => {
    const { c, batch } = await fixture();
    await pool.query('UPDATE suppliers SET bank_branch_code = $2 WHERE id = $1', [batch.members[0]!.supplierId, branch]);
    const res = await generate(c, batch.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(JSON.stringify(res.state.body)).not.toContain('content');
  });

  it('a payee branch written with a dash is sent as its six digits', async () => {
    const { c, batch } = await fixture();
    await pool.query("UPDATE suppliers SET bank_branch_code = '250-655' WHERE id = $1", [batch.members[0]!.supplierId]);
    const res = await generate(c, batch.id, 'standard_bank');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(dataOf<{ content: string }>(res).content).toContain('T250655');
  });
});

describe('eft-generate field widths (K-067 / AP-03)', () => {
  const refused = async (c: string, batchId: string) => {
    const res = await generate(c, batchId);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(JSON.stringify(res.state.body)).not.toContain('"content"');
  };

  it('refuses a payee account of more than 11 digits instead of sending its last 11', async () => {
    const { c, batch } = await fixture();
    await pool.query("UPDATE suppliers SET bank_account_number = '123456789012345' WHERE id = $1", [batch.members[0]!.supplierId]);
    await refused(c, batch.id);
  });

  it('refuses an originating account of more than 11 digits', async () => {
    const { c, batch } = await fixture({ number: '123456789012', branch: BRANCH });
    await refused(c, batch.id);
  });

  it('refuses a payment too large for the 11-digit cents field (R1 000 000 000.00)', async () => {
    const { c, batch } = await fixture();
    await pool.query('UPDATE supplier_payments SET total_amount = 1000000000 WHERE id = $1', [batch.members[0]!.id]);
    await refused(c, batch.id);
  });

  it('accepts the largest payment the field holds (R999 999 999.99)', async () => {
    const { c, batch } = await fixture();
    await pool.query('UPDATE supplier_payments SET total_amount = 999999999.99 WHERE id = $1', [batch.members[0]!.id]);
    const res = await generate(c, batch.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(dataOf<{ content: string }>(res).content).toContain('99999999999');
  });

  it('refuses a batch whose total overflows the 12-digit trailer (11 payments of R999 999 999.99)', async () => {
    const { c, batch } = await fixture(undefined, Array(11).fill(999999999.99));
    await refused(c, batch.id);
  });
});

describe('eft-generate originating account must be an active bank account', () => {
  it('refuses a paying account that has been deactivated', async () => {
    const { c, bank, batch } = await fixture();
    await pool.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [bank]);
    const res = await generate(c, batch.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(JSON.stringify(res.state.body)).not.toContain('"content"');
  });

  it('refuses a paying account that is not a bank account, though it carries a number', async () => {
    const { c, bank, batch } = await fixture();
    await pool.query("UPDATE gl_accounts SET account_subtype = 'payable' WHERE id = $1", [bank]);
    const res = await generate(c, batch.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(JSON.stringify(res.state.body)).not.toContain('"content"');
  });
});

describe('eft-generate truncation warnings', () => {
  it('names a payee whose name or reference the bank format cuts, and says nothing otherwise', async () => {
    const { c, batch } = await fixture();
    const clean = await generate(c, batch.id, 'standard_bank');
    expect(dataOf<{ warnings?: string[] }>(clean).warnings ?? []).toEqual([]);
    const long = 'A supplier name that is well over thirty characters';
    await pool.query('UPDATE suppliers SET name = $2 WHERE id = $1', [batch.members[0]!.supplierId, long]);
    await pool.query("UPDATE supplier_payments SET reference = 'INV-0000000000001-LONG' WHERE id = $1", [batch.members[1]!.id]);
    const res = await generate(c, batch.id, 'standard_bank');
    const warnings = dataOf<{ warnings: string[] }>(res).warnings;
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toContain(long);
    expect(warnings.join('\n')).toContain('INV-0000000000001-LONG');
  });

  it('fnb cuts the batch reference to 12, and says so', async () => {
    const { c, batch } = await fixture();
    const warnings = dataOf<{ warnings: string[] }>(await generate(c, batch.id, 'fnb')).warnings;
    expect(warnings).toEqual([expect.stringContaining(batch.number)]);
  });
});
