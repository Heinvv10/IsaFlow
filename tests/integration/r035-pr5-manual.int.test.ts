/**
 * R-035 PR5 round 1, decision D2 (Hein, 2026-10-06; adversarial REPRO 3): the
 * bank-feed exemption covers only payments recorded from a bank line that came
 * from a live bank feed or an imported statement. A hand-keyed line — "Spend
 * Money" — allocated to a supplier goes through approval: with supplier_payment
 * enforcement on and a rule matching the amount it is refused 409 before any
 * write, and nothing is written. A refund (money in) is not an instruction to
 * pay and stays open; so does everything when enforcement is off or no rule
 * matches. The exemption wrapper reads the line's provenance itself, so a
 * hand-keyed line reaching a creator by any other path is refused by the
 * backstop (fail closed).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bankTransactionsManual from '../../pages/api/accounting/bank-transactions-manual';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import { recordSupplierBankPayment } from '@/modules/accounting/services/ap/supplierAutoAllocate';
import { applyRules } from '@/modules/accounting/services/bank/bankRulesMatchingService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { messageOf } from './r035-pr2.helpers';
import { cleanupPr5, enforcePay, inRequest, payCompany, plantBill, plantSupplier } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';

beforeAll(async () => { a = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM bank_categorisation_rules WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_feed_connections WHERE company_id = ANY($1)', [companies]);
  await cleanupPr5(pool, companies, [a]);
});

/** A company whose every supplier payment over R1 000 needs an owner, enforced unless said otherwise. */
async function fixture(opts: { enforced?: boolean; over?: number } = {}) {
  const { company: c, bank } = await payCompany(pool, [[a, 'admin']], companies);
  await plantRule(pool, c, 'owner', { documentType: 'supplier_payment', name: 'Owner pays', operator: 'greater_than', value: opts.over ?? 1000 });
  if (opts.enforced !== false) await enforcePay(pool, c, 'supplier_payment', a);
  const supplierId = await plantSupplier(pool, c);
  const billId = await plantBill(pool, c, supplierId, a, 5000);
  return { c, bank, supplierId, billId };
}

const spend = (c: string, bank: string, supplierId: string, type: 'spend' | 'receive' = 'spend') => callRoute(
  bankTransactionsManual, tokens[a]!, c, 'POST', {
    type, bankAccountId: bank, date: '2026-09-01', amount: 5000, description: 'keyed by hand',
    allocationType: 'supplier', entityId: supplierId, autoApply: 'fifo',
  }, '/api/accounting/bank-transactions-manual');

/** Everything a supplier allocation could have written. */
async function written(c: string, billId: string) {
  const { rows: [row] } = await pool.query(
    `SELECT (SELECT count(*)::INT FROM bank_transactions WHERE company_id = $1) AS lines,
            (SELECT count(*)::INT FROM gl_journal_entries WHERE company_id = $1) AS journals,
            (SELECT count(*)::INT FROM supplier_payments WHERE company_id = $1) AS payments,
            (SELECT amount_paid::FLOAT8 FROM supplier_invoices WHERE id = $2) AS paid`, [c, billId]);
  return row as { lines: number; journals: number; payments: number; paid: number };
}

/** A bank line already in the company: keyed by hand, from an imported statement, or from a live feed. */
async function plantLine(c: string, bank: string, provenance: 'manual' | 'import' | 'feed', amount = -5000): Promise<string> {
  let feed: string | null = null;
  if (provenance === 'feed') {
    feed = (await pool.query(
      "INSERT INTO bank_feed_connections(company_id, bank_account_id, provider) VALUES($1,$2,'stitch') RETURNING id", [c, bank])).rows[0].id;
  }
  return (await pool.query(
    `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status,
       import_batch_id, bank_feed_connection_id)
     VALUES($1,$2,DATE '2026-09-01',$3,'R035 line','imported',$4,$5) RETURNING id`,
    [c, bank, amount, provenance === 'import' ? crypto.randomUUID() : null, feed])).rows[0].id;
}

const allocate = (c: string, bankTransactionId: string, supplierId: string) => callRoute(bankTransactionsAction, tokens[a]!, c, 'POST',
  { action: 'allocate', bankTransactionId, allocationType: 'supplier', entityId: supplierId }, '/api/accounting/bank-transactions-action');

describe('Spend Money to a supplier', () => {
  it('REPRO 3: refused 409 before any write under enforcement — no bank line, no journal, no payment, the bill unpaid', async () => {
    const { c, bank, supplierId, billId } = await fixture();
    const res = await spend(c, bank, supplierId);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(messageOf(res)).toMatch(/needs owner approval before it can be paid \(rule: Owner pays\), and a bank line keyed by hand/);
    expect(await written(c, billId)).toEqual({ lines: 0, journals: 0, payments: 0, paid: 0 });
  });

  it('records and pays as before when no rule matches, or enforcement is off', async () => {
    const below = await fixture({ over: 10_000 });
    expect((await spend(below.c, below.bank, below.supplierId)).state.statusCode).toBe(201);
    expect((await written(below.c, below.billId)).paid).toBe(5000);
    const off = await fixture({ enforced: false });
    expect((await spend(off.c, off.bank, off.supplierId)).state.statusCode).toBe(201);
  });

  it('Receive Money from a supplier (a refund, money in) is not an instruction to pay: recorded under enforcement', async () => {
    const { c, bank, supplierId } = await fixture({ enforced: false });
    // R6 000 on account with the supplier, so a R5 000 refund of it is within what they owe back.
    await pool.query(
      `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,status,created_by)
       VALUES($1,$2,DATE '2026-08-01',6000,'eft','processed',$3)`, [c, supplierId, a]);
    await enforcePay(pool, c, 'supplier_payment', a);
    const res = await spend(c, bank, supplierId, 'receive');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    const { rows } = await pool.query(
      "SELECT total_amount::FLOAT8 AS t, status FROM supplier_payments WHERE company_id = $1 AND payment_method = 'refund'", [c]);
    expect(rows).toEqual([{ t: -5000, status: 'processed' }]);
  });
});

describe('allocating an existing line to a supplier', () => {
  it('a hand-keyed line is refused 409 before any write', async () => {
    const { c, bank, supplierId, billId } = await fixture();
    const line = await plantLine(c, bank, 'manual');
    const res = await allocate(c, line, supplierId);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(await written(c, billId)).toEqual({ lines: 1, journals: 0, payments: 0, paid: 0 });
  });

  it.each(['import', 'feed'] as const)('a line from %s is evidence: allocated and paid under enforcement', async (provenance) => {
    const { c, bank, supplierId, billId } = await fixture();
    const line = await plantLine(c, bank, provenance);
    const res = await allocate(c, line, supplierId);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await written(c, billId)).toMatchObject({ payments: 1, paid: 5000 });
  });
});

describe('the exemption wrapper reads the line itself', () => {
  it('a creator called for a hand-keyed line is refused by the backstop (no exemption claimed for it)', async () => {
    const { c, bank, supplierId } = await fixture();
    const line = await plantLine(c, bank, 'manual');
    const outcome = await inRequest(pool, a, c, async (db) => {
      const je = (await db.query(
        "INSERT INTO gl_journal_entries(company_id,entry_date,created_by,status,description) VALUES($1,DATE '2026-09-01',$2,'posted','R035') RETURNING id",
        [c, a])).rows[0].id;
      return recordSupplierBankPayment({
        companyId: c, supplierId, bankTxId: line, bankAccountId: bank, journalEntryId: je,
        amount: 5000, paymentDate: '2026-09-01', description: 'R035', userId: a, autoApply: 'none',
      });
    }).then(() => 'written', (e: Error) => e.message);
    expect(outcome).toMatch(/^R035_APPROVAL_REQUIRED/);
  });
});

describe('the bank-rule sweep', () => {
  it('skips a supplier rule on a hand-keyed line under enforcement (counted), and still posts an imported one', async () => {
    const { c, bank, supplierId } = await fixture();
    const manual = await plantLine(c, bank, 'manual');
    const imported = await plantLine(c, bank, 'import');
    await pool.query(
      `INSERT INTO bank_categorisation_rules(company_id, rule_name, match_field, match_type, match_pattern,
         supplier_id, vat_code, auto_create_entry, is_active, priority)
       VALUES($1,'R035 rule','description','contains','R035 line',$2,'none',true,true,1)`, [c, supplierId]);
    const result = await inRequest(pool, a, c, () => applyRules(c, bank, a));
    expect(result.autoPostSkippedApprovalRequired).toBe(1);
    const { rows } = await pool.query('SELECT id, status FROM bank_transactions WHERE company_id = $1 ORDER BY id', [c]);
    expect(Object.fromEntries(rows.map((x) => [x.id, x.status]))).toEqual({ [manual]: 'imported', [imported]: 'allocated' });
    expect((await pool.query('SELECT count(*)::INT AS n FROM supplier_payments WHERE company_id = $1', [c])).rows[0].n).toBe(1);
  });
});
