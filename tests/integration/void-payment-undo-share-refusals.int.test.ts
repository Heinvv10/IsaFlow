/**
 * void_payment(undo_share) refusals against a real ledger (step 6). Every one leaves the payment processed: the plan
 * runs inside the void's pre-write hook, so a refusal writes nothing. The happy paths are in
 * void-payment-undo-share.int.test.ts; the breaker's repros (cumulative capacity, partial multi-bill shares, a hand
 * undo, a re-contra) in breaker6-undo.int.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, runOn, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { billWithJournal, dropStepExtras, postedJournal, seedStepAccounts, type StepAccounts } from './helpers/shareUndoFixture';
import { text, undoShareKit } from './helpers/undoShareKit';

const DATABASE_URL = process.env.DATABASE_URL;
type Row = Record<string, unknown>;
let fx: Fixture;
let a: StepAccounts;
const { call, callHere, contra, payStatus, scenario } = undoShareKit(() => fx, () => a);
/** The undo on the caller's own connection (inside runOn), for the race below. */
const undoCall = (pay: string, share: string) =>
  callHere({ payment_id: pay, undo_share: true, share_journal_id: share, idempotency_key: crypto.randomUUID() });
const undo = (pay: string, share: string, extra: Row = {}) =>
  call({ payment_id: pay, undo_share: true, share_journal_id: share, idempotency_key: crypto.randomUUID(), ...extra });
const account = async (code: string, type: string, subtype: string | null) => String(((await sql`
  INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
  VALUES (${fx.companyId}::UUID, ${code}, ${`${code} ${fx.tag}`}, ${type}, ${subtype}, 'debit', true) RETURNING id`) as Row[])[0]!.id);
/** A processed payment of `amount` on bill `billId`, posted DR AP / CR `credit`, written as the apply path leaves it. */
async function seededPayment(billId: string, amount: number, credit: string, method: string): Promise<string> {
  const je = await postedJournal(fx, '2026-06-01', [{ account: a.ap, debit: amount }, { account: credit, credit: amount }]);
  const [p] = (await sql`INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, payment_method,
      bank_account_id, status, created_by, gl_journal_entry_id)
    VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, '2026-06-01', ${amount}, ${method}, ${credit}::UUID, 'processed',
            ${fx.userId}::UUID, ${je}::UUID) RETURNING id`) as Row[];
  await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${String(p!.id)}::UUID, ${billId}::UUID, ${amount})`;
  await sql`UPDATE supplier_invoices SET amount_paid = amount_paid + ${amount}, status = 'paid' WHERE id = ${billId}::UUID`;
  return String(p!.id);
}

describe.skipIf(!DATABASE_URL)('void_payment undo_share — refusals write nothing', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts journals and voids payments.');
    fx = await seedFixture('UNDOR', DATABASE_URL!);
    a = await seedStepAccounts(fx);
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM approval_rules WHERE company_id = ${fx.companyId}::UUID AND name = 'step6 big journals'`;
    await sql`DELETE FROM approval_enforcement WHERE company_id = ${fx.companyId}::UUID AND document_type = 'manual_journal'`;
    await dropStepExtras(fx);
    await dropFixture(fx);
  }, 120000);

  it('a share journal that is not the share, one that misses a bill account, and an unknown id', async () => {
    const s = await scenario('WRONG', '2026-05-31');
    const notShare = await postedJournal(fx, '2026-05-31', [{ account: a.expense, debit: 1150 }, { account: a.bank, credit: 1150 }]);
    expect(text(await undo(s.pay, notShare))).toMatch(/does not hold .* on 1560731/);
    const thin = await postedJournal(fx, '2026-05-31', [{ account: a.clearing, debit: 1150 }, { account: a.expense2, credit: 1000 },
      { account: a.vatInput, credit: 150, vatType: 'standard' }]);
    expect(text(await undo(s.pay, thin))).toMatch(/does not hold .* account 6000/);
    expect(text(await undo(s.pay, crypto.randomUUID()))).toBe('share_journal_id is not a journal of this company.');
    expect(await payStatus(s.pay)).toBe('processed');
  }, 120000);

  it('a payment from the bank, and one crediting an account with no subtype and no statement lines', async () => {
    const s = await scenario('NOTCONTRA', '2026-05-31');
    const bill = await billWithJournal(fx, a, 'BANKPAID', '2026-05-10', [{ account: a.expense, debit: 100 }]);
    const bankPay = await seededPayment(bill.id, 100, a.bank, 'eft');
    expect(text(await undo(bankPay, s.share))).toMatch(/is not a contra settlement/);
    const bare = await account('1599', 'asset', null);
    const bill2 = await billWithJournal(fx, a, 'BARESUB', '2026-05-10', [{ account: a.expense, debit: 100 }]);
    const barePay = await seededPayment(bill2.id, 100, bare, 'eft');
    expect(text(await undo(barePay, s.share))).toMatch(/no subtype and no statement lines/);
    expect([await payStatus(bankPay), await payStatus(barePay)]).toEqual(['processed', 'processed']);
  }, 120000);

  it('a contra whose journal also posted another payment document', async () => {
    const je = await postedJournal(fx, '2026-09-17', [{ account: a.ap, debit: 200 }, { account: a.clearing, credit: 200 }]);
    const ids: string[] = [];
    for (const n of ['SIB1', 'SIB2']) {
      const b = await billWithJournal(fx, a, n, '2026-05-10', [{ account: a.expense, debit: 100 }]);
      const [p] = (await sql`INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, payment_method,
          bank_account_id, status, created_by, gl_journal_entry_id)
        VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, '2026-09-17', 100, 'contra', ${a.clearing}::UUID, 'processed',
                ${fx.userId}::UUID, ${je}::UUID) RETURNING id`) as Row[];
      await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${String(p!.id)}::UUID, ${b.id}::UUID, 100)`;
      ids.push(String(p!.id));
    }
    const sib = await postedJournal(fx, '2026-05-31', [{ account: a.clearing, debit: 200 }, { account: a.expense, credit: 200 }]);
    expect(text(await undo(ids[0]!, sib))).toMatch(/posted other payment documents too/);
    expect(await payStatus(ids[0]!)).toBe('processed');
  }, 120000);

  it('a live journal already carrying this bill and payment\'s undo reference (belt and braces)', async () => {
    const s = await scenario('TWICE', '2026-05-31');
    await postedJournal(fx, '2026-05-31', [{ account: a.expense, debit: 1 }, { account: a.clearing, credit: 1 }], `undo-share:${s.pay}:${s.bill.id}`);
    expect(text(await undo(s.pay, s.share))).toMatch(/was already undone by JE-/);
    expect(await payStatus(s.pay)).toBe('processed');
  }, 120000);

  it('a hand undo of the share uses its capacity: the undo is refused, naming the hand journal', async () => {
    const s = await scenario('HAND', '2026-05-31');
    const [hand] = (await sql`SELECT entry_number FROM gl_journal_entries WHERE id = ${await postedJournal(fx, '2026-05-31', [
      { account: a.expense, debit: 1000 }, { account: a.vatInput, debit: 150, vatType: 'standard' },
      { account: a.clearing, credit: 1150 }], 'undo share by hand')}::UUID`) as Row[];
    expect(text(await undo(s.pay, s.share))).toMatch(new RegExp(`does not hold .*including hand journal ${String(hand!.entry_number)}`));
    expect(await payStatus(s.pay)).toBe('processed');
  }, 120000);

  it('a share journal that is a document\'s own posting (not a manual journal) is not a share', async () => {
    const s = await scenario('NOTMANUAL', '2026-05-31');
    await sql`UPDATE gl_journal_entries SET source = 'auto_supplier_invoice' WHERE id = ${s.share}::UUID AND company_id = ${fx.companyId}::UUID`;
    expect(text(await undo(s.pay, s.share))).toMatch(/is a auto_supplier_invoice posting .* not a share/);
    expect(await payStatus(s.pay)).toBe('processed');
  }, 120000);

  it('undo_amounts naming a bill the payment did not settle, or more than it applied', async () => {
    const s = await scenario('AMOUNTS', '2026-05-31');
    expect(text(await undo(s.pay, s.share, { undo_amounts: [{ bill_id: crypto.randomUUID(), amount: 10 }] })))
      .toMatch(/which Payment .* is not applied to/);
    expect(text(await undo(s.pay, s.share, { undo_amounts: [{ bill_id: s.bill.id, amount: 1150.01 }] })))
      .toMatch(/at most the R\s?1\s?150\.00/);
    expect(await payStatus(s.pay)).toBe('processed');
  }, 120000);

  it('a late-claimed bill, and an undo account that has been deactivated', async () => {
    const late = await account('1141', 'asset', 'vat_input_late_claim');
    const lc = await scenario('LATE', '2026-05-31', '2026-05-10', [{ account: a.expense, debit: 1000 }, { account: late, debit: 150 }]);
    expect(text(await undo(lc.pay, lc.share))).toMatch(/was late-claimed/);
    const spare = await account('6200', 'expense', 'operating_expense');
    const off = await scenario('INACTIVE', '2026-05-31', '2026-05-10', [{ account: spare, debit: 1000 }, { account: a.vatInput, debit: 150, vatType: 'standard' }]);
    await sql`UPDATE gl_accounts SET is_active = false WHERE id = ${spare}::UUID`;
    expect(text(await undo(off.pay, off.share))).toMatch(/Account 6200 is deactivated/);
    expect([await payStatus(lc.pay), await payStatus(off.pay)]).toEqual(['processed', 'processed']);
  }, 120000);

  it('two undos racing on one share: the second waits on the share lock, then sees the first and is refused', async () => {
    const legs = [{ account: a.expense, debit: 1000 }, { account: a.vatInput, debit: 150, vatType: 'standard' }];
    const b1 = await billWithJournal(fx, a, 'RACE1', '2026-05-10', legs);
    const b2 = await billWithJournal(fx, a, 'RACE2', '2026-05-11', legs);
    const p1 = await contra(b1.id, 1150);
    const p2 = await contra(b2.id, 1150);
    const share = await postedJournal(fx, '2026-05-31', [{ account: a.clearing, debit: 1150 }, { account: a.expense, credit: 1000 },
      { account: a.vatInput, credit: 150, vatType: 'standard' }]);
    const c1 = await fx.pool.connect();
    await c1.query('BEGIN');
    try {
      const first = await runOn(fx, c1, () => undoCall(p1, share));
      expect(first.isError, text(first)).toBeFalsy();
      const second = undo(p2, share);           // its own transaction: blocks on the share's row lock
      await new Promise((r) => { setTimeout(r, 400); });
      await c1.query('COMMIT');
      expect(text(await second)).toMatch(/does not hold/);
    } catch (err) {
      await c1.query('ROLLBACK');
      throw err;
    } finally {
      c1.release();
    }
    expect([await payStatus(p1), await payStatus(p2)]).toEqual(['cancelled', 'processed']);
  }, 120000);

  it('refuses (never rolls) a share date in a closed period or a locked VAT period', async () => {
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${fx.companyId}::UUID, ${`FY25 ${fx.tag}`}, 1, 2025, '2025-01-01', '2025-12-31', 'closed')`;
    const closed = await scenario('CLOSED', '2025-12-31', '2025-11-10');
    expect(text(await undo(closed.pay, closed.share))).toMatch(/2025-12-31, which is not in an open fiscal period/);
    const locked = await scenario('LOCKED', '2026-03-31', '2026-03-10');
    await sql`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
      VALUES (${fx.companyId}::UUID, '2026-03-01', '2026-03-31', 0, 0, 0, NOW(), 'step6 test')`;
    expect(text(await undo(locked.pay, locked.share))).toMatch(/inside the locked VAT period 2026-03-01 to 2026-03-31/);
    expect([await payStatus(closed.pay), await payStatus(locked.pay)]).toEqual(['processed', 'processed']);
  }, 120000);

  it('R-035: a matching rule refuses per journal AND on the call\'s total (two R600 bills under a R1,000 rule)', async () => {
    const legs = [{ account: a.expense, debit: 600 }];
    const b1 = await billWithJournal(fx, a, 'R035A', '2026-05-10', legs);
    const b2 = await billWithJournal(fx, a, 'R035B', '2026-05-11', legs);
    const je = await postedJournal(fx, '2026-09-17', [{ account: a.ap, debit: 1200 }, { account: a.clearing, credit: 1200 }]);
    const [p] = (await sql`INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, payment_method,
        bank_account_id, status, created_by, gl_journal_entry_id)
      VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, '2026-09-17', 1200, 'contra', ${a.clearing}::UUID, 'processed',
              ${fx.userId}::UUID, ${je}::UUID) RETURNING id`) as Row[];
    for (const b of [b1, b2]) {
      await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${String(p!.id)}::UUID, ${b.id}::UUID, 600)`;
      await sql`UPDATE supplier_invoices SET amount_paid = 600, status = 'paid' WHERE id = ${b.id}::UUID`;
    }
    const share = await postedJournal(fx, '2026-05-31', [{ account: a.clearing, debit: 1200 }, { account: a.expense, credit: 1200 }]);
    await sql`INSERT INTO approval_enforcement (company_id, document_type, enabled_by) VALUES (${fx.companyId}::UUID, 'manual_journal', 'step6')`;
    await sql`INSERT INTO approval_rules (company_id, name, document_type, condition_field, condition_operator, condition_value, approver_role, is_active)
      VALUES (${fx.companyId}::UUID, 'step6 big journals', 'manual_journal', 'amount', 'greater_than', 1000, 'owner', true)`;
    expect(text(await undo(String(p!.id), share, { dry_run: true }))).toMatch(/Manual journals are enforced: a journal of R1200.00/);
    expect(text(await undo(String(p!.id), share))).toMatch(/Manual journals are enforced/);
    expect(await payStatus(String(p!.id))).toBe('processed');
  }, 120000);
});
