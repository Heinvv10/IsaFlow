/**
 * The supplier refund document, end to end on real SQL.
 *
 * A money-IN line against a supplier posts DR Bank / CR Accounts Payable. Until
 * migration 681 it created no document, so the control account moved, the
 * subledger did not, and the supplier's on-account credit stayed overstated by
 * the whole refund. It now mints a NEGATIVE on-account entry.
 *
 * What is pinned here is not that a row appears. It is that the row AGREES with
 * every reader built on it — the unapplied listing, the aged netting, the
 * statement and the reconciler all move by the same figure and in the same
 * direction — and that the two refusals hold: a refund larger than the credit
 * is refused before anything is written, and the document is never applied to a
 * bill.
 */
import { afterAll, beforeAll, beforeEach, expect, it, describe } from 'vitest';
import { Pool, type PoolClient } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const DAY = '2026-05-15';

/**
 * Its own tenant, with literal ids, so a failing assertion names one row rather
 * than a total and the teardown can delete by company without touching
 * anything a parallel suite owns.
 */
const fx = {
  company: '00000000-0000-0000-0000-0000000rf000'.replace(/r/g, 'a'),
  user: '00000000-0000-0000-0000-0000000rf001'.replace(/r/g, 'a'),
  supplier: '00000000-0000-0000-0000-0000000rf002'.replace(/r/g, 'a'),
  bankAccount: '00000000-0000-0000-0000-0000000rf003'.replace(/r/g, 'a'),
  apAccount: '00000000-0000-0000-0000-0000000rf004'.replace(/r/g, 'a'),
  customer: '00000000-0000-0000-0000-0000000rf005'.replace(/r/g, 'a'),
  arAccount: '00000000-0000-0000-0000-0000000rf006'.replace(/r/g, 'a'),
};

let billSeq = 0;
let lineSeq = 0;

async function seedBankLine(amount: number): Promise<string> {
  lineSeq += 1;
  const { rows } = await pool.query(
    `INSERT INTO bank_transactions
       (company_id, bank_account_id, transaction_date, amount, description, status)
     VALUES ($1,$2,$3,$4,$5,'imported') RETURNING id::TEXT`,
    [fx.company, fx.bankAccount, DAY, amount, `Refund fixture line ${lineSeq}`]);
  return String(rows[0].id);
}

async function seedBill(total: number): Promise<string> {
  billSeq += 1;
  const { rows } = await pool.query(
    `INSERT INTO supplier_invoices
       (company_id, supplier_id, invoice_number, invoice_date, due_date,
        total_amount, amount_paid, status, created_by)
     VALUES ($1,$2,$3,'2026-05-01','2026-06-01',$4,0,'approved',$5) RETURNING id::TEXT`,
    [fx.company, fx.supplier, `RF-BILL-${billSeq}`, total, fx.user]);
  return String(rows[0].id);
}

async function cleanup(): Promise<void> {
  const co = [fx.company];
  await pool.query(
    `DELETE FROM payment_allocations WHERE payment_id IN
       (SELECT id FROM supplier_payments WHERE company_id = $1::UUID)`, co);
  for (const t of [
    'supplier_payments', 'bank_transactions', 'supplier_invoices',
    'gl_journal_lines', 'gl_journal_entries',
  ]) {
    await pool.query(`DELETE FROM ${t} WHERE company_id = $1::UUID`, co);
  }
  // `gl_account_balances` is maintained by a trigger on posted journals, holds
  // an FK to `gl_accounts` and carries NO company_id of its own — so it is
  // deleted THROUGH the accounts, and before them. Teardown order is not
  // cosmetic: leave this out and the first run passes while the second dies in
  // beforeAll on rows the first could not delete.
  await pool.query(
    `DELETE FROM gl_account_balances WHERE gl_account_id IN
       (SELECT id FROM gl_accounts WHERE company_id = $1::UUID)`, co);
  // `fiscal_periods` rows are created for this tenant by the
  // posting path itself, not by the seed above — which is exactly why they are
  // easy to forget and why the second run is where it bites.
  await pool.query(
    `DELETE FROM customer_payment_allocations WHERE payment_id IN
       (SELECT id FROM customer_payments WHERE company_id = $1::UUID)`, co);
  await pool.query('DELETE FROM customer_payments WHERE company_id = $1::UUID', co);
  for (const t of ['gl_accounts', 'suppliers', 'customers', 'fiscal_periods']) {
    await pool.query(`DELETE FROM ${t} WHERE company_id = $1::UUID`, co);
  }
  await pool.query('DELETE FROM companies WHERE id = $1::UUID', co);
  await pool.query('DELETE FROM users WHERE id = $1::TEXT', [fx.user]);
}

beforeAll(async () => {
  await cleanup();
  await pool.query(
    `INSERT INTO companies (id, name, is_active) VALUES ($1,'Supplier Refund Fixture',true)`,
    [fx.company]);
  await pool.query(
    `INSERT INTO users (id, email, first_name) VALUES ($1::TEXT,'refund@fixture.local','Refund')`,
    [fx.user]);
  await pool.query(
    'INSERT INTO suppliers (id, company_id, name) VALUES ($1,$2,$3)',
    [fx.supplier, fx.company, 'Refund Fixture Supplier']);
  // `is_system_account` on both: `getSystemAccountId('payable', ...)` resolves
  // the AP control through it, and the allocation cannot post without one.
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
       account_subtype, normal_balance, is_active, is_system_account)
     VALUES ($1,$2,'RF1000','Refund Fixture Bank','asset','bank','debit',true,true)`,
    [fx.bankAccount, fx.company]);
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
       account_subtype, normal_balance, is_active, is_system_account)
     VALUES ($1,$2,'RF2110','Refund Fixture Accounts Payable','liability','payable','credit',true,true)`,
    [fx.apAccount, fx.company]);
  await pool.query(
    'INSERT INTO customers (id, company_id, name) VALUES ($1,$2,$3)',
    [fx.customer, fx.company, 'Refund Fixture Customer']);
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
       account_subtype, normal_balance, is_active, is_system_account)
     VALUES ($1,$2,'RF1100','Refund Fixture Accounts Receivable','asset','receivable','debit',true,true)`,
    [fx.arAccount, fx.company]);
});

afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
});

/**
 * Run one unit of work inside the request's transaction shape, COMMITting only
 * where the real wrappers would. `withAuth` COMMITs on anything under 500 and
 * rolls back at 500 and above, which is precisely why the refund's ceiling is
 * checked before the journal posts — a business refusal answered 400 after the
 * first write would COMMIT the orphan journal. `commit: false` here is that
 * same rule: a throw leaves nothing behind.
 */
async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  const { als } = await import('@/lib/als');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const out = await als.run(
        { client, userId: fx.user, companyId: fx.company, claims: {} }, fn,
      );
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    client.release();
  }
}

async function allocate(bankTxId: string) {
  const { allocateTransaction } = await import(
    '@/modules/accounting/services/bank/bankAllocationService');
  // Positional. `contraAccountId` is null for a supplier line — the AP control
  // is resolved from the system accounts — and the direction is read off the
  // bank line's own sign, which is the whole discriminator under test.
  return inRequest(() => allocateTransaction(
    fx.company, bankTxId, null, fx.user, undefined, 'supplier', fx.supplier,
  ));
}

async function refundRows() {
  const { rows } = await pool.query(
    `SELECT sp.id::TEXT AS id, sp.total_amount, sp.payment_method, sp.status,
            sp.gl_journal_entry_id::TEXT AS je, sp.reference,
            (SELECT COUNT(*)::INT FROM payment_allocations pa
              WHERE pa.payment_id = sp.id) AS allocs
       FROM supplier_payments sp
      WHERE sp.company_id = $1::UUID AND sp.payment_method = 'refund'
      ORDER BY sp.created_at`,
    [fx.company]);
  return rows;
}

/** Credit the supplier is holding, from the shared basis every AP tool reads. */
async function supplierUnapplied(): Promise<number> {
  const { getUnappliedPayments } = await import(
    '@/modules/accounting/services/ap/unappliedPaymentService');
  const res = await inRequest(() => getUnappliedPayments(fx.company, { asAt: DAY, limit: 100 }));
  return res.rows
    .filter((r) => r.supplierId === fx.supplier)
    .reduce((a, r) => a + r.unappliedAmount, 0);
}

beforeEach(async () => {
  // Every test starts from the same books. Cheaper and far more legible than a
  // per-test tenant, and the fixture company is disposable by construction.
  await pool.query(
    `DELETE FROM payment_allocations WHERE payment_id IN
       (SELECT id FROM supplier_payments WHERE company_id = $1::UUID)`, [fx.company]);
  await pool.query('DELETE FROM supplier_payments WHERE company_id = $1::UUID', [fx.company]);
  // The BILLS go too, and leaving them out is what made this suite depend on
  // its own running order: the default auto-apply is fifo, so one bill left
  // open by an earlier test silently consumes the next test's payment and its
  // on-account credit reads zero.
  await pool.query('DELETE FROM supplier_invoices WHERE company_id = $1::UUID', [fx.company]);
  await pool.query(
    `DELETE FROM customer_payment_allocations WHERE payment_id IN
       (SELECT id FROM customer_payments WHERE company_id = $1::UUID)`, [fx.company]);
  await pool.query('DELETE FROM customer_payments WHERE company_id = $1::UUID', [fx.company]);
});

describe('allocating a supplier deposit', () => {
  it('refuses a refund with no on-account credit behind it, writing nothing', async () => {
    const before = await pool.query(
      'SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1::UUID',
      [fx.company]);
    const tx = await seedBankLine(400);

    await expect(allocate(tx)).rejects.toThrow(/owing the company/i);

    // NOT ONE WRITE. The ceiling is decided before `createJournalEntry`, so
    // there is no journal to orphan and no bank row left reading 'allocated'.
    const after = await pool.query(
      'SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1::UUID',
      [fx.company]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const line = await pool.query('SELECT status FROM bank_transactions WHERE id = $1::UUID', [tx]);
    expect(line.rows[0].status).toBe('imported');
    expect(await refundRows()).toHaveLength(0);
  });

  it('mints a negative, unallocated document and nets the credit by exactly it', async () => {
    // R1,000 of credit: a payment against no bill.
    await allocate(await seedBankLine(-1000));
    expect(await supplierUnapplied()).toBeCloseTo(1000, 2);

    const tx = await seedBankLine(400);
    await allocate(tx);

    const [refund] = await refundRows();
    expect(Number(refund.total_amount)).toBe(-400);
    expect(refund.payment_method).toBe('refund');
    expect(refund.status).toBe('processed');
    expect(refund.reference).toBe(tx);
    expect(refund.je).toBeTruthy();
    // Never applied, at any auto-apply mode: a negative remainder applied to a
    // bill un-pays it.
    expect(Number(refund.allocs)).toBe(0);

    // The netting, which is the whole point. R1,000 in, R400 back.
    expect(await supplierUnapplied()).toBeCloseTo(600, 2);
  });

  it('posts DR Bank / CR Accounts Payable, and the document claims that journal', async () => {
    await allocate(await seedBankLine(-1000));
    await allocate(await seedBankLine(400));
    const [refund] = await refundRows();

    const { rows } = await pool.query(
      `SELECT gl_account_id::TEXT AS acct, COALESCE(SUM(debit),0)::float8 AS dr,
              COALESCE(SUM(credit),0)::float8 AS cr
         FROM gl_journal_lines WHERE journal_entry_id = $1::UUID GROUP BY 1`,
      [refund.je]);
    const by = new Map(rows.map((r) => [r.acct, r]));
    expect(by.get(fx.bankAccount)!.dr).toBeCloseTo(400, 2);
    expect(by.get(fx.apAccount)!.cr).toBeCloseTo(400, 2);
  });

  it('refuses a refund one cent past the credit, and the earlier refund counts', async () => {
    await allocate(await seedBankLine(-1000));
    await allocate(await seedBankLine(600));
    // R400 of credit left. The FIRST refund must have consumed R600 of the
    // ceiling — if the basis dropped it, this next line would be allowed.
    await expect(allocate(await seedBankLine(400.01)))
      .rejects.toThrow(/owing the company/i);
    await allocate(await seedBankLine(400));
    expect(await supplierUnapplied()).toBeCloseTo(0, 2);
  });

  it('does not let an applied payment fund a refund', async () => {
    // The R1,000 settles the bill in full under the default fifo strategy, so
    // none of it is on account and there is nothing for a refund to return.
    await seedBill(1000);
    await allocate(await seedBankLine(-1000));
    await expect(allocate(await seedBankLine(10)))
      .rejects.toThrow(/owing the company/i);
  });
});

describe('the readers agree with each other', () => {
  beforeEach(async () => {
    await allocate(await seedBankLine(-1000));
    await allocate(await seedBankLine(400));
  });

  it('lists the refund as a negative row, typed by its method not its sign', async () => {
    const { getUnappliedPayments } = await import(
      '@/modules/accounting/services/ap/unappliedPaymentService');
    const res = await inRequest(() => getUnappliedPayments(fx.company, { asAt: DAY, limit: 100 }));
    const refunds = res.rows.filter((r) => r.kind === 'refund');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.unappliedAmount).toBeCloseTo(-400, 2);
    expect(res.rows.filter((r) => r.kind === 'payment')).toHaveLength(1);
  });

  it('nets the refund into the aged creditors row for that supplier', async () => {
    const { getUnappliedByEntity } = await import(
      '@/modules/accounting/services/shared/agedNetting');
    const map = await inRequest(() => getUnappliedByEntity(fx.company, 'ap', DAY));
    // R1,000 held less R400 handed back. The old `> EPS` threshold dropped the
    // refund row entirely and this read 1000.
    expect(map.get(fx.supplier)!.payments).toBeCloseTo(600, 2);
  });

  it('carries the refund onto the statement as a negative payment', async () => {
    const { fetchSupplierStatementData } = await import(
      '@/modules/accounting/services/ap/supplierStatementService');
    const st = await inRequest(() => fetchSupplierStatementData(fx.company, fx.supplier, DAY));
    const refund = st!.transactions.filter((t) => t.type === 'refund');
    expect(refund).toHaveLength(1);
    expect(refund[0]!.debit).toBeCloseTo(-400, 2);
    // A refund RAISES what the company owes again, which the running balance
    // must show: a negative debit adds.
    const payments = st!.transactions.filter((t) => t.type === 'payment' || t.type === 'refund');
    expect(payments.reduce((a, t) => a + t.debit, 0)).toBeCloseTo(600, 2);
  });

  it('leaves the reconciler no posting_with_no_document for the refund journal', async () => {
    const { reconcileSubledger } = await import(
      '@/modules/accounting/services/reconciliation/subledgerReconciliationService');
    const rec = await inRequest(() => reconcileSubledger(fx.company, 'ap', DAY));
    const [refund] = await refundRows();
    const orphan = rec.reconcilingItems.find((i) => i.type === 'posting_with_no_document');
    expect(orphan?.documentIds ?? []).not.toContain(refund.je);
  });

  it('skips the refund in the auto-apply back-fill, with a reason', async () => {
    const { getUnappliedPaymentBasis } = await import(
      '@/modules/accounting/services/shared/unappliedPaymentBasis');
    const { basisSources, SKIP_REFUND } = await import(
      '@/modules/accounting/services/shared/autoApplyBackfillSkips');
    const basis = await inRequest(() => getUnappliedPaymentBasis(fx.company, 'ap', DAY));
    const sources = basisSources('ap', basis.rows);
    const refund = sources.find((s) => s.remainder < 0);
    // Reported with a reason rather than filtered out: the plan has to
    // reconcile line for line against list_unapplied_payments, which shows it.
    expect(refund?.skippedReason).toBe(SKIP_REFUND);
  });
});

describe('reversal', () => {
  it('cancels the refund document when its allocation is unwound', async () => {
    await allocate(await seedBankLine(-1000));
    const tx = await seedBankLine(400);
    await allocate(tx);
    expect(await supplierUnapplied()).toBeCloseTo(600, 2);

    const { reverseReconciledTransaction } = await import(
      '@/modules/accounting/services/bank/bankAllocationService');
    await inRequest(() => reverseReconciledTransaction(fx.company, tx, fx.user));

    const [refund] = await refundRows();
    // A negative payment with NO allocation rows: the unwind loop has nothing
    // to reopen and must still cancel the document.
    expect(refund.status).toBe('cancelled');
    // The credit is back where it was before the refund.
    expect(await supplierUnapplied()).toBeCloseTo(1000, 2);
  });
});

describe('the customer mirror', () => {
  async function allocateCustomer(bankTxId: string) {
    const { allocateTransaction } = await import(
      '@/modules/accounting/services/bank/bankAllocationService');
    return inRequest(() => allocateTransaction(
      fx.company, bankTxId, null, fx.user, undefined, 'customer', fx.customer,
    ));
  }

  async function customerRefunds() {
    const { rows } = await pool.query(
      `SELECT total_amount, payment_method, status, bank_reference
         FROM customer_payments
        WHERE company_id = $1::UUID AND payment_method = 'refund'`, [fx.company]);
    return rows;
  }

  it('mints a negative receipt for money going back out, and nets the credit', async () => {
    // A receipt with nothing to settle: R900 sitting on the customer's account.
    await allocateCustomer(await seedBankLine(900));

    const tx = await seedBankLine(-300);
    await allocateCustomer(tx);

    const [refund] = await customerRefunds();
    expect(Number(refund.total_amount)).toBe(-300);
    expect(refund.payment_method).toBe('refund');
    expect(refund.status).toBe('confirmed');
    expect(refund.bank_reference).toBe(tx);

    const { getUnappliedReceipts } = await import(
      '@/modules/accounting/services/ar/unappliedReceiptService');
    const res = await inRequest(() => getUnappliedReceipts(fx.company, { asAt: DAY, limit: 100 }));
    const mine = res.rows.filter((r) => r.customerId === fx.customer);
    expect(mine.reduce((a, r) => a + r.unappliedAmount, 0)).toBeCloseTo(600, 2);
    expect(mine.filter((r) => r.kind === 'refund')).toHaveLength(1);
  });

  it('refuses a customer refund with no credit behind it, writing nothing', async () => {
    const before = await pool.query(
      'SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1::UUID',
      [fx.company]);
    const tx = await seedBankLine(-300);
    await expect(allocateCustomer(tx)).rejects.toThrow(/owing Refund Fixture Customer/i);
    const after = await pool.query(
      'SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1::UUID',
      [fx.company]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(await customerRefunds()).toHaveLength(0);
  });
});

describe('two refunds at once', () => {
  /**
   * The same unit of work as `inRequest`, but on a CALLER-SUPPLIED client, so
   * two of them can be interleaved deliberately. Each one is its own
   * transaction on its own connection, which is what a second HTTP request is.
   */
  async function inRequestOn<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
    const { als } = await import('@/lib/als');
    await client.query('BEGIN');
    try {
      const out = await als.run(
        { client, userId: fx.user, companyId: fx.company, claims: {} }, fn,
      );
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  async function allocateOn(client: PoolClient, bankTxId: string) {
    const { allocateTransaction } = await import(
      '@/modules/accounting/services/bank/bankAllocationService');
    return inRequestOn(client, () => allocateTransaction(
      fx.company, bankTxId, null, fx.user, undefined, 'supplier', fx.supplier,
    ));
  }

  it('makes the second refund WAIT for the first, then see the reduced credit', async () => {
    // R1,058 of credit and two refunds of R1,058. Without the contact lock both
    // read the same credit, both pass the ceiling and both mint — R2,116
    // returned against R1,058 held, and no constraint can see it because each
    // row is individually legal and the illegal thing is the PAIR.
    //
    // DRIVEN THROUGH THE PLANNER, not through two whole allocations. Two
    // concurrent `allocateTransaction` calls collide on the journal-number
    // unique index first, so the run fails for a reason that has nothing to do
    // with refunds and the race under test is never reached. Here the
    // interleaving is explicit: B is provably still waiting while A holds the
    // lock, which is the property, and neither the scheduler nor an unrelated
    // index decides the outcome.
    await allocate(await seedBankLine(-1058));

    const { planSupplierRefund, recordSupplierRefund } = await import(
      '@/modules/accounting/services/ap/supplierRefundDocument');
    const { als } = await import('@/lib/als');

    const a = await pool.connect();
    const b = await pool.connect();
    let bSettled = false;
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      const ctx = (client: PoolClient) => (
        { client, userId: fx.user, companyId: fx.company, claims: {} });

      // A takes the supplier lock, spends the whole credit, and HOLDS.
      const first = await als.run(ctx(a), async () => {
        const plan = await planSupplierRefund(fx.company, fx.supplier, 1058, DAY);
        await recordSupplierRefund({
          companyId: fx.company, supplierId: fx.supplier, bankTxId: await seedBankLine(1058),
          bankAccountId: fx.bankAccount, journalEntryId: null as unknown as string,
          amount: 1058, paymentDate: DAY, description: 'A', userId: fx.user,
        });
        return plan;
      });
      expect(first.onAccountCredit).toBeCloseTo(1058, 2);

      // B asks the same question. It must BLOCK on the supplier row rather than
      // read the credit A is consuming.
      const second = als.run(ctx(b), () => planSupplierRefund(fx.company, fx.supplier, 1058, DAY))
        .then((r) => { bSettled = true; return r; })
        .catch((e) => { bSettled = true; throw e; });
      const guard = second.catch(() => undefined);

      await new Promise((r) => setTimeout(r, 400));
      // Remove the lock and this is the assertion that goes red: B has already
      // read the stale credit and resolved.
      expect(bSettled).toBe(false);

      await a.query('COMMIT');
      // Now B proceeds, sees a credit of zero, and refuses.
      await expect(second).rejects.toThrow(/owing the company/i);
      await guard;
      await b.query('ROLLBACK');
    } finally {
      a.release();
      b.release();
    }

    // THE OUTCOME. Exactly one refund, and the credit exhausted but never
    // negative — true whichever way the loser was refused.
    expect(await refundRows()).toHaveLength(1);
    expect(await supplierUnapplied()).toBeCloseTo(0, 2);
  });
});

describe('the statement-balances API agrees with the aged netting', () => {
  it('nets the refund in both, by the same figure', async () => {
    await allocate(await seedBankLine(-1000));
    await allocate(await seedBankLine(400));

    const { getSupplierStatementBalances } = await import(
      '@/modules/accounting/services/ap/supplierStatementBalancesService');
    const { getUnappliedByEntity } = await import(
      '@/modules/accounting/services/shared/agedNetting');

    const balances = await inRequest(() => getSupplierStatementBalances(fx.company, DAY));
    const netting = await inRequest(() => getUnappliedByEntity(fx.company, 'ap', DAY));

    const mine = balances.find((r) => r.entityId === fx.supplier);
    // R1,000 held less R400 handed back. The per-row `GREATEST(total - alloc,
    // 0)` floored the refund to zero and this read 1000 against the netting's
    // 600 — the statement-balances screen and the aged report disagreeing by
    // exactly the cash that came back.
    expect(mine!.onAccount).toBeCloseTo(600, 2);
    expect(mine!.onAccount).toBeCloseTo(netting.get(fx.supplier)!.payments, 2);
  });

  it('keeps a supplier whose refunds exceed its credit, as a NEGATIVE row', async () => {
    // `HAVING SUM(funds.amount) > 0` dropped this supplier outright, so the
    // screen showed no on-account figure at all for the one case where the
    // company owes MORE than the aged buckets say.
    await allocate(await seedBankLine(-1000));
    await allocate(await seedBankLine(1000));
    // Every cent returned: the credit is exactly zero, so the row is absent by
    // the zero rule rather than by the sign rule. Give it a negative one.
    await pool.query(
      `UPDATE supplier_payments SET total_amount = -1200
        WHERE company_id = $1::UUID AND payment_method = 'refund'`, [fx.company]);

    const { getSupplierStatementBalances } = await import(
      '@/modules/accounting/services/ap/supplierStatementBalancesService');
    const balances = await inRequest(() => getSupplierStatementBalances(fx.company, DAY));
    const mine = balances.find((r) => r.entityId === fx.supplier);
    expect(mine).toBeDefined();
    expect(mine!.onAccount).toBeCloseTo(-200, 2);
    // A negative on-account RAISES what is owed, which is the point.
    expect(mine!.netBalance).toBeCloseTo(mine!.total + 200, 2);
  });
});
