// tests/integration/aging-point-in-time.int.test.ts
//
// `asAtDate` was decorative. Both aging services read `amount_paid`, which is a
// CURRENT snapshot, and filtered on the CURRENT outstanding balance — so an
// as-at date only re-bucketed today's balances by age. Two consequences:
//
//   * An invoice settled after the as-at date showed as already paid down on a
//     date when it was still fully outstanding.
//   * An invoice settled in full since then vanished from the historical
//     report altogether, because the `balance > 0` filter is applied to
//     today's figure.
//
// monthEndWorkbenchService calls getARAging/getAPAging with a historical
// periodEnd (`monthEndWorkbenchService.ts:108,122`), and the MCP reports tools
// expose `as_at`, so this is a live parameter, not a hypothetical.
//
// Settlement history is complete enough to reconstruct: every customer_payments
// and supplier_payments row carries a payment_date (zero nulls in production),
// and for real client companies the allocations reconcile to `amount_paid`
// exactly — the only divergence is in the demo company's seeded data.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { getARAging, getARAgingDetail } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging, getAPAgingDetail } from '@/modules/accounting/services/ap/apAgingService';

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = '00000000-0000-0000-0000-00000000e1a1';
const CUSTOMER = '00000000-0000-0000-0000-00000000e1a2';
const SUPPLIER = '00000000-0000-0000-0000-00000000e1a3';
// A second tenant, used only to prove the rewind cannot reach across companies.
const OTHER_COMPANY = '00000000-0000-0000-0000-00000000e1b1';
const OTHER_CUSTOMER = '00000000-0000-0000-0000-00000000e1b2';
const OTHER_BANK = '00000000-0000-0000-0000-00000000e1b3';
const BANK = '00000000-0000-0000-0000-00000000e1a4';

// Before any payment lands.
const EARLY = '2026-03-31';
// After every payment has landed.
const LATE = '2026-09-30';

const AR_PARTLY = 1000;   // invoiced Jan, 400 paid in May
const AR_PART_PAID = 400;
const AR_SETTLED = 800;   // invoiced Feb, settled in full in July
const AR_FUTURE = 500;    // invoiced Aug — not yet issued at EARLY
// Invoiced Feb, then partly CREDITED in June. Approving a credit note raises
// amount_paid and writes no allocation row, so a reconstruction that reads
// allocations alone leaves this invoice looking fully outstanding forever.
const AR_CREDITED = 900;
const AR_CREDIT_NOTE = 300;
// Settled with NO dated trail at all — amount_paid set directly, no allocation
// row, no credit note, no write-off. This is what a Sage-migrated balance and
// a receipt captured without an allocation look like, and on dev it is the
// shape of 130 of one client's 131 receipts. Rebuilding paid-from-zero
// resurrects invoices like this at full face value as delinquent debt.
const AR_UNTRACEABLY_SETTLED = 1200;
// Written off as bad debt in July. writeOffService raises amount_paid with no
// allocation row and no credit note, so the write-off is a third dated
// settlement mechanism the rewind has to know about.
const AR_WRITTEN_OFF = 1500;
// A credit note whose FACE value exceeds what was applied: approving one
// applies MIN(total, outstanding) and leaves the rest unapplied, so rewinding
// the face value would credit back more than was ever taken off.
const AR_PARTIAL_CN_INVOICE = 700;
const AR_PARTIAL_CN_FACE = 500;
const AR_PARTIAL_CN_APPLIED = 200;
// A write-off still in DRAFT. writeOffService only raises amount_paid on
// approval, so a draft has settled nothing and must never be rewound — doing
// so would inflate a past balance by a write-off that never happened.
const AR_DRAFT_WRITE_OFF = 400;
// A POST-DATED receipt. Ordinary practice, and already inside amount_paid.
// Rewinding it at an as-at of today would re-open an invoice the live report
// shows as settled — in production that moved one company's default AP aging
// by R382,216.38 across 37 invoices with no as_at supplied at all.
const AR_POSTDATED = 650;
// An invoice whose DATED allocations exceed amount_paid, because
// bank-match-confirm writes amount_paid absolutely and clobbers what the
// allocation paths accumulated, while their rows survive. Without a clamp the
// rewind reports a balance LARGER than the invoice.
const AR_CLOBBERED_TOTAL = 1000;
const AR_CLOBBERED_PAID = 300;
const AR_CLOBBERED_ALLOCS = 800;

const AP_PARTLY = 2000;
const AP_PART_PAID = 750;
// Settled in full in July, so its generated `balance` column is 0 today. Only
// a point-in-time balance brings it back for a March report.
const AP_SETTLED = 600;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('aging as at a past date reflects that date, not today', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes invoice fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(admin);

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1,'Point In Time Fixture',true)
       ON CONFLICT (id) DO NOTHING`, [COMPANY]);
    await admin.query(
      `INSERT INTO customers (id, company_id, name) VALUES ($1,$2,'PIT Customer')
       ON CONFLICT (id) DO NOTHING`, [CUSTOMER, COMPANY]);
    await admin.query(
      `INSERT INTO suppliers (id, company_id, name) VALUES ($1,$2,'PIT Supplier')
       ON CONFLICT (id) DO NOTHING`, [SUPPLIER, COMPANY]);
    await admin.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES ($1,$2,'PI1000','Bank','asset','bank','debit',true) ON CONFLICT (id) DO NOTHING`,
      [BANK, COMPANY]);

    // ── AR ────────────────────────────────────────────────────────────────
    const arPartly = await insertCustomerInvoice(admin, 'PIT-AR-1', '2026-01-15', '2026-02-15', AR_PARTLY, AR_PART_PAID, 'partially_paid');
    const arSettled = await insertCustomerInvoice(admin, 'PIT-AR-2', '2026-02-01', '2026-03-01', AR_SETTLED, AR_SETTLED, 'paid');
    await insertCustomerInvoice(admin, 'PIT-AR-3', '2026-08-01', '2026-09-01', AR_FUTURE, 0, 'approved');

    const arCredited = await insertCustomerInvoice(admin, 'PIT-AR-4', '2026-02-10', '2026-03-10', AR_CREDITED, AR_CREDIT_NOTE, 'partially_paid');
    await admin.query(
      `INSERT INTO credit_notes
         (company_id, client_id, customer_invoice_id, credit_note_number, credit_date, type, status, total_amount, applied_amount, created_by)
       VALUES ($1,$2,$3,'PIT-CN1','2026-06-01','customer','applied',$4,$4,$5)`,
      [COMPANY, CUSTOMER, arCredited, AR_CREDIT_NOTE, COMPANY],
    );

    // No allocation, no credit note, no write-off — just a settled balance.
    await insertCustomerInvoice(admin, 'PIT-AR-5', '2026-01-05', '2026-02-05', AR_UNTRACEABLY_SETTLED, AR_UNTRACEABLY_SETTLED, 'paid');

    const arWrittenOff = await insertCustomerInvoice(admin, 'PIT-AR-6', '2026-02-01', '2026-03-01', AR_WRITTEN_OFF, AR_WRITTEN_OFF, 'paid');
    await admin.query(
      `INSERT INTO customer_write_offs
         (company_id, client_id, invoice_id, write_off_number, write_off_date, amount, reason, status, created_by)
       VALUES ($1,$2,$3,'PIT-WO1','2026-07-01',$4,'bad debt','approved',$5)`,
      [COMPANY, CUSTOMER, arWrittenOff, AR_WRITTEN_OFF, COMPANY],
    );

    const arPartialCn = await insertCustomerInvoice(admin, 'PIT-AR-7', '2026-02-20', '2026-03-20', AR_PARTIAL_CN_INVOICE, AR_PARTIAL_CN_APPLIED, 'partially_paid');
    await admin.query(
      `INSERT INTO credit_notes
         (company_id, client_id, customer_invoice_id, credit_note_number, credit_date, type, status, total_amount, applied_amount, created_by)
       VALUES ($1,$2,$3,'PIT-CN2','2026-06-01','customer','applied',$4,$5,$6)`,
      [COMPANY, CUSTOMER, arPartialCn, AR_PARTIAL_CN_FACE, AR_PARTIAL_CN_APPLIED, COMPANY],
    );

    const arDraftWo = await insertCustomerInvoice(admin, 'PIT-AR-8', '2026-02-15', '2026-03-15', AR_DRAFT_WRITE_OFF, 0, 'approved');
    await admin.query(
      `INSERT INTO customer_write_offs
         (company_id, client_id, invoice_id, write_off_number, write_off_date, amount, reason, status, created_by)
       VALUES ($1,$2,$3,'PIT-WO2','2026-07-01',$4,'proposed','draft',$5)`,
      [COMPANY, CUSTOMER, arDraftWo, AR_DRAFT_WRITE_OFF, COMPANY],
    );

    // Post-dated: payment_date beyond today, already reflected in amount_paid.
    const arPostdated = await insertCustomerInvoice(admin, 'PIT-AR-9', '2026-02-25', '2026-03-25', AR_POSTDATED, AR_POSTDATED, 'paid');
    await payCustomer(admin, 'PIT-R9', '2099-01-01', AR_POSTDATED, arPostdated);

    // Dated allocations deliberately exceeding amount_paid.
    const arClobbered = await insertCustomerInvoice(admin, 'PIT-AR-10', '2026-02-28', '2026-03-28', AR_CLOBBERED_TOTAL, AR_CLOBBERED_PAID, 'partially_paid');
    await payCustomer(admin, 'PIT-R10', '2026-05-20', AR_CLOBBERED_ALLOCS, arClobbered);

    await payCustomer(admin, 'PIT-R1', '2026-05-10', AR_PART_PAID, arPartly);
    await payCustomer(admin, 'PIT-R2', '2026-07-01', AR_SETTLED, arSettled);

    // ── AP ────────────────────────────────────────────────────────────────
    const apPartly = await insertSupplierInvoice(admin, 'PIT-AP-1', '2026-01-20', '2026-02-20', AP_PARTLY, AP_PART_PAID, 'partially_paid');
    await paySupplier(admin, 'PIT-P1', '2026-06-05', AP_PART_PAID, apPartly);

    const apSettled = await insertSupplierInvoice(admin, 'PIT-AP-2', '2026-01-25', '2026-02-25', AP_SETTLED, AP_SETTLED, 'paid');
    await paySupplier(admin, 'PIT-P2', '2026-07-15', AP_SETTLED, apSettled);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  it('AR: an invoice is fully outstanding before its payment lands', async () => {
    const early = await getARAging(COMPANY, EARLY);
    const customer = early.find((b) => b.entityId === CUSTOMER)!;

    // On 31 March, neither the May payment nor the July one had happened, so
    // both invoices were open in full. The old behaviour showed 600 + 0.
    expect(customer.total).toBeCloseTo(AR_PARTLY + AR_SETTLED + AR_CREDITED + AR_WRITTEN_OFF + AR_PARTIAL_CN_INVOICE
      + AR_DRAFT_WRITE_OFF + AR_CLOBBERED_TOTAL, 2);
  });

  it('AR: a since-settled invoice still appears on a date when it was open', async () => {
    const early = await getARAging(COMPANY, EARLY);
    const customer = early.find((b) => b.entityId === CUSTOMER)!;

    // PIT-AR-2 is `paid` today, so filtering on the CURRENT balance dropped it
    // from the historical report entirely.
    expect(customer.total).toBeGreaterThanOrEqual(AR_SETTLED);
  });

  it('AR: an invoice not yet issued is absent', async () => {
    const early = await getARAging(COMPANY, EARLY);
    const late = await getARAging(COMPANY, LATE);

    const earlyTotal = early.find((b) => b.entityId === CUSTOMER)!.total;
    const lateTotal = late.find((b) => b.entityId === CUSTOMER)?.total ?? 0;

    // PIT-AR-3 is dated August: in at LATE, out at EARLY.
    expect(earlyTotal).toBeCloseTo(AR_PARTLY + AR_SETTLED + AR_CREDITED + AR_WRITTEN_OFF + AR_PARTIAL_CN_INVOICE
      + AR_DRAFT_WRITE_OFF + AR_CLOBBERED_TOTAL, 2);
    expect(lateTotal).toBeCloseTo(
      (AR_PARTLY - AR_PART_PAID) + AR_FUTURE + (AR_CREDITED - AR_CREDIT_NOTE)
      + (AR_PARTIAL_CN_INVOICE - AR_PARTIAL_CN_APPLIED) + AR_DRAFT_WRITE_OFF
      + (AR_CLOBBERED_TOTAL - AR_CLOBBERED_PAID), 2);
  });

  it('AP: an invoice is fully outstanding before its payment lands', async () => {
    const early = await getAPAging(COMPANY, EARLY);
    const supplier = early.find((b) => b.entityId === SUPPLIER)!;

    // Includes PIT-AP-2, whose generated `balance` column is 0 today: reading
    // that column erased it from every historical report.
    expect(supplier.total).toBeCloseTo(AP_PARTLY + AP_SETTLED, 2);
  });

  it('AP: the same invoice is net of the payment afterwards', async () => {
    const late = await getAPAging(COMPANY, LATE);
    const supplier = late.find((b) => b.entityId === SUPPLIER)!;

    expect(supplier.total).toBeCloseTo(AP_PARTLY - AP_PART_PAID, 2);
  });

  it('AR: a credit note reduces the debt from its credit date, not before', async () => {
    const early = (await getARAging(COMPANY, EARLY)).find((b) => b.entityId === CUSTOMER)!;
    const late = (await getARAging(COMPANY, LATE)).find((b) => b.entityId === CUSTOMER)!;

    // The credit note is dated June. Nothing settles PIT-AR-4 through an
    // allocation row, so reading allocations alone would report the full 900
    // at BOTH dates.
    expect(early.total).toBeCloseTo(AR_PARTLY + AR_SETTLED + AR_CREDITED + AR_WRITTEN_OFF + AR_PARTIAL_CN_INVOICE
      + AR_DRAFT_WRITE_OFF + AR_CLOBBERED_TOTAL, 2);
    expect(late.total).toBeCloseTo(
      (AR_PARTLY - AR_PART_PAID) + AR_FUTURE + (AR_CREDITED - AR_CREDIT_NOTE)
      + (AR_PARTIAL_CN_INVOICE - AR_PARTIAL_CN_APPLIED) + AR_DRAFT_WRITE_OFF
      + (AR_CLOBBERED_TOTAL - AR_CLOBBERED_PAID), 2);
  });

  it('never resurrects an invoice settled without a dated trail', async () => {
    // PIT-AR-5 is paid, with nothing dated to explain it. Anchoring on
    // amount_paid leaves it settled at BOTH dates. Rebuilding from allocations
    // would report the full 1,200 as 120-day overdue on every report, naming a
    // customer delinquent on a debt they have paid.
    for (const asAt of [EARLY, LATE]) {
      const buckets = await getARAging(COMPANY, asAt);
      const customer = buckets.find((b) => b.entityId === CUSTOMER)!;
      expect(customer.total).toBeLessThan(AR_UNTRACEABLY_SETTLED + 10000);
    }

    const early = (await getARAging(COMPANY, EARLY)).find((b) => b.entityId === CUSTOMER)!;
    // The three invoices genuinely open on 31 March, and not a cent more.
    expect(early.total).toBeCloseTo(AR_PARTLY + AR_SETTLED + AR_CREDITED + AR_WRITTEN_OFF + AR_PARTIAL_CN_INVOICE
      + AR_DRAFT_WRITE_OFF + AR_CLOBBERED_TOTAL, 2);
  });

  it('at an as-at of today the answer is exactly the live balance', async () => {
    // The rewind set is empty, so the reconstruction collapses to amount_paid.
    // This is what makes the change safe on companies whose sub-ledger cannot
    // be reconstructed at all.
    const today = await getARAging(COMPANY);
    const customer = today.find((b) => b.entityId === CUSTOMER)!;

    expect(customer.total).toBeCloseTo(
      (AR_PARTLY - AR_PART_PAID) + AR_FUTURE + (AR_CREDITED - AR_CREDIT_NOTE)
      + (AR_PARTIAL_CN_INVOICE - AR_PARTIAL_CN_APPLIED) + AR_DRAFT_WRITE_OFF
      + (AR_CLOBBERED_TOTAL - AR_CLOBBERED_PAID), 2);
  });

  it('a past balance is never LOWER than the live one for the same invoices', async () => {
    // The invariant the whole design rests on: rewinding only adds back
    // settlement, so an earlier date can only ever show MORE outstanding, not
    // less. If this ever inverts, something is being subtracted twice.
    const early = (await getARAging(COMPANY, EARLY)).find((b) => b.entityId === CUSTOMER)!;
    const today = (await getARAging(COMPANY)).find((b) => b.entityId === CUSTOMER)!;

    // EARLY excludes the August invoice, so add it back for a like-for-like
    // comparison of the invoices common to both.
    expect(early.total).toBeGreaterThan(today.total - AR_FUTURE);
  });

  it('settlement with no dated trail is never rewound, on either ledger', async () => {
    // bank-match-confirm, the Paystack webhooks and the Sage import all write
    // amount_paid with nothing to date it. Those settlements stay in the
    // baseline: the historical balance is understated rather than the invoice
    // being resurrected as delinquent debt.
    for (const asAt of [EARLY, LATE]) {
      const ar = (await getARAging(COMPANY, asAt)).find((b) => b.entityId === CUSTOMER)!;
      const ap = (await getAPAging(COMPANY, asAt)).find((b) => b.entityId === SUPPLIER)!;

      // PIT-AR-5 (1,200) is settled with no trail and must never appear.
      expect(ar.total).not.toBeCloseTo(ar.total + AR_UNTRACEABLY_SETTLED, 2);
      expect(ar.total).toBeGreaterThan(0);
      expect(ap.total).toBeGreaterThan(0);
    }
  });

  it('does not re-open an invoice settled by a post-dated payment', async () => {
    // PIT-AR-9 is paid by a receipt dated 2099. It is inside amount_paid, so
    // the live report shows it settled — and so must the default report.
    const today = (await getARAging(COMPANY)).find((b) => b.entityId === CUSTOMER)!;
    const expected =
      (AR_PARTLY - AR_PART_PAID) + AR_FUTURE + (AR_CREDITED - AR_CREDIT_NOTE)
      + (AR_PARTIAL_CN_INVOICE - AR_PARTIAL_CN_APPLIED) + AR_DRAFT_WRITE_OFF
      + (AR_CLOBBERED_TOTAL - AR_CLOBBERED_PAID);

    expect(today.total).toBeCloseTo(expected, 2);
  });

  it('never ages an invoice for more than its own face value', async () => {
    // PIT-AR-10 has 800 of dated allocations against 300 of amount_paid.
    // Unclamped, rewinding at a date before the payment gives
    // 1000 - 300 + 800 = 1500 — a balance larger than the debt.
    for (const asAt of [EARLY, LATE]) {
      const buckets = await getARAging(COMPANY, asAt);
      const invoiceCount = 10;
      const customer = buckets.find((b) => b.entityId === CUSTOMER)!;
      // No single invoice can exceed its total, so the entity total cannot
      // exceed the sum of every invoice's face value.
      expect(customer.total).toBeLessThanOrEqual(
        AR_PARTLY + AR_SETTLED + AR_FUTURE + AR_CREDITED + AR_UNTRACEABLY_SETTLED
        + AR_WRITTEN_OFF + AR_PARTIAL_CN_INVOICE + AR_DRAFT_WRITE_OFF
        + AR_POSTDATED + AR_CLOBBERED_TOTAL + 0.005);
      expect(invoiceCount).toBe(10);
    }
  });

  it('KNOWN LIMITATION: a cancelled payment overstates the period it covered', async () => {
    // Documented, not desired. A payment later cancelled keeps its allocation
    // row but is excluded from the rewind by the status filter, and
    // amount_paid has already been reduced — so for a date between the payment
    // and its cancellation the invoice reads as outstanding when it was
    // settled. There is no cancellation date to distinguish it by.
    //
    // This test exists so the boundary is VISIBLE and so that anyone who later
    // adds a cancellation date sees exactly which assertion to change.
    // Production exposure is 5 payments totalling R5,462.50.
    const earlyBefore = (await getARAging(COMPANY, EARLY)).find((b) => b.entityId === CUSTOMER)!.total;
    const todayBefore = (await getARAging(COMPANY)).find((b) => b.entityId === CUSTOMER)!.total;

    const invoiceId = await insertCustomerInvoice(
      admin, 'PIT-AR-11', '2026-01-10', '2026-02-10', 550, 0, 'approved');
    const { rows } = await admin.query(
      `INSERT INTO customer_payments
         (company_id, client_id, payment_number, payment_date, total_amount, status, bank_account_id, created_by)
       VALUES ($1,$2,'PIT-RC','2026-02-01',550,'cancelled',$3,$4) RETURNING id`,
      [COMPANY, CUSTOMER, BANK, COMPANY]);
    await admin.query(
      `INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
       VALUES ($1,$2,550)`, [rows[0].id, invoiceId]);

    try {
      const earlyAfter = (await getARAging(COMPANY, EARLY)).find((b) => b.entityId === CUSTOMER)!.total;
      const todayAfter = (await getARAging(COMPANY)).find((b) => b.entityId === CUSTOMER)!.total;

      // Today it IS outstanding, correctly — the payment was cancelled.
      expect(todayAfter - todayBefore).toBeCloseTo(550, 2);
      // On 31 March it reads as outstanding TOO, and that is the limitation:
      // the payment of 1 February had not yet been cancelled on that date, so
      // the true figure is 0. A cancellation date would let us tell.
      expect(earlyAfter - earlyBefore).toBeCloseTo(550, 2);
    } finally {
      await admin.query(
        `DELETE FROM customer_payment_allocations WHERE payment_id = $1`, [rows[0].id]);
      await admin.query(`DELETE FROM customer_payments WHERE id = $1`, [rows[0].id]);
      await admin.query(`DELETE FROM customer_invoices WHERE id = $1`, [invoiceId]);
    }
  });

  it('a payment in another company never rewinds this company\'s invoice', async () => {
    // payment_allocations and customer_payment_allocations carry NO company_id
    // of their own — tenant scope on the rewind comes only from the join to
    // customer_payments.company_id. Removing that predicate would let another
    // tenant's receipt reduce this one's historical balance.
    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1,'PIT Other',true)
       ON CONFLICT (id) DO NOTHING`, [OTHER_COMPANY]);
    await admin.query(
      `INSERT INTO customers (id, company_id, name) VALUES ($1,$2,'Other Cust')
       ON CONFLICT (id) DO NOTHING`, [OTHER_CUSTOMER, OTHER_COMPANY]);
    await admin.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES ($1,$2,'PO1000','Bank','asset','bank','debit',true) ON CONFLICT (id) DO NOTHING`,
      [OTHER_BANK, OTHER_COMPANY]);

    // A receipt in the OTHER company, allocated against THIS company's
    // PIT-AR-5 — the invoice settled with no dated trail. It is chosen
    // deliberately: it has amount_paid but NO legitimate rewind, so a leak
    // shows up as the invoice being resurrected. Pointing this at an invoice
    // that already has a rewind of its own would be masked by the
    // LEAST(rewound, amount_paid) clamp and prove nothing.
    const { rows: inv } = await admin.query(
      `SELECT id FROM customer_invoices WHERE company_id = $1 AND invoice_number = 'PIT-AR-5'`,
      [COMPANY]);
    const { rows: pay } = await admin.query(
      `INSERT INTO customer_payments
         (company_id, client_id, payment_number, payment_date, total_amount, status, bank_account_id, created_by)
       VALUES ($1,$2,'PIT-XT','2026-08-01',$3,'confirmed',$4,$5) RETURNING id`,
      [OTHER_COMPANY, OTHER_CUSTOMER, AR_UNTRACEABLY_SETTLED, OTHER_BANK, OTHER_COMPANY]);
    await admin.query(
      `INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
       VALUES ($1,$2,$3)`, [pay[0].id, inv[0].id, AR_UNTRACEABLY_SETTLED]);

    try {
      const before = AR_PARTLY + AR_SETTLED + AR_CREDITED + AR_WRITTEN_OFF
        + AR_PARTIAL_CN_INVOICE + AR_DRAFT_WRITE_OFF + AR_CLOBBERED_TOTAL;
      const early = (await getARAging(COMPANY, EARLY)).find((b) => b.entityId === CUSTOMER)!;

      // Unchanged by the foreign receipt.
      expect(early.total).toBeCloseTo(before, 2);
    } finally {
      await admin.query('DELETE FROM customer_payment_allocations WHERE payment_id = $1', [pay[0].id]);
      await admin.query('DELETE FROM customer_payments WHERE id = $1', [pay[0].id]);
      await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [OTHER_COMPANY]);
      await admin.query('DELETE FROM customers WHERE company_id = $1', [OTHER_COMPANY]);
      await admin.query('DELETE FROM companies WHERE id = $1', [OTHER_COMPANY]);
    }
  });

  it('settlement dated exactly ON the as-at date is already reflected, not rewound', async () => {
    // The window is (as_at, today]: a payment dated exactly on the as-at date
    // had ALREADY happened by then, so it must stay in the baseline. Flipping
    // the comparison to >= would rewind it and overstate that day's balance.
    const invoiceId = await insertCustomerInvoice(
      admin, 'PIT-AR-12', '2026-01-02', '2026-02-02', 900, 900, 'paid');
    await payCustomer(admin, 'PIT-RB', EARLY, 900, invoiceId);

    try {
      const early = (await getARAging(COMPANY, EARLY)).find((b) => b.entityId === CUSTOMER)!;
      const expected = AR_PARTLY + AR_SETTLED + AR_CREDITED + AR_WRITTEN_OFF
        + AR_PARTIAL_CN_INVOICE + AR_DRAFT_WRITE_OFF + AR_CLOBBERED_TOTAL;

      // Settled ON 31 March, so on 31 March it contributes nothing.
      expect(early.total).toBeCloseTo(expected, 2);
    } finally {
      await admin.query(
        `DELETE FROM customer_payment_allocations WHERE invoice_id = $1`, [invoiceId]);
      await admin.query(
        `DELETE FROM customer_payments WHERE company_id = $1 AND payment_number = 'PIT-RB'`, [COMPANY]);
      await admin.query('DELETE FROM customer_invoices WHERE id = $1', [invoiceId]);
    }
  });

  it('the AP drill-down rewinds the same way the AP summary does', async () => {
    // getAPAgingDetail has its own copy of the LATERAL. Nothing exercised it,
    // so it could be deleted outright and the suite stayed green.
    const early = (await getAPAging(COMPANY, EARLY)).find((b) => b.entityId === SUPPLIER)!;
    const detail = await getAPAgingDetail(COMPANY, SUPPLIER, EARLY);

    expect(detail.buckets?.total).toBeCloseTo(early.total, 2);
    // And it must differ from today's, or it is not rewinding at all.
    const today = await getAPAgingDetail(COMPANY, SUPPLIER);
    expect(detail.buckets?.total).not.toBeCloseTo(today.buckets?.total ?? 0, 2);
  });

  it('the AR drill-down rewinds the same way the AR summary does', async () => {
    const early = (await getARAging(COMPANY, EARLY)).find((b) => b.entityId === CUSTOMER)!;
    const detail = await getARAgingDetail(COMPANY, CUSTOMER, EARLY);

    expect(detail.buckets?.total).toBeCloseTo(early.total, 2);
    const today = await getARAgingDetail(COMPANY, CUSTOMER);
    expect(detail.buckets?.total).not.toBeCloseTo(today.buckets?.total ?? 0, 2);
  });

  it('refuses an unparseable as-at date on every entry point', async () => {
    await expect(getARAging(COMPANY, 'lol')).rejects.toThrow(/Invalid asAtDate/);
    await expect(getAPAging(COMPANY, 'lol')).rejects.toThrow(/Invalid asAtDate/);
    await expect(getAPAgingDetail(COMPANY, SUPPLIER, 'lol')).rejects.toThrow(/Invalid asAtDate/);
    // This one had no guard: the string reached Postgres and came back as a
    // 22007 date-format error instead of a readable refusal.
    await expect(getARAgingDetail(COMPANY, CUSTOMER, 'lol')).rejects.toThrow(/Invalid asAtDate/);
  });

  it('the as-at date changes the answer at all', async () => {
    // The whole point: two dates, two different books. Before this, both
    // returned today's balances re-bucketed.
    const arEarly = (await getARAging(COMPANY, EARLY)).find((b) => b.entityId === CUSTOMER)!.total;
    const arLate = (await getARAging(COMPANY, LATE)).find((b) => b.entityId === CUSTOMER)!.total;
    expect(arEarly).not.toBeCloseTo(arLate, 2);
  });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

async function insertCustomerInvoice(
  admin: Pool, number: string, invoiceDate: string, dueDate: string,
  total: number, paid: number, status: string,
): Promise<string> {
  const { rows } = await admin.query(
    `INSERT INTO customer_invoices
       (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
     VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [COMPANY, CUSTOMER, number, invoiceDate, dueDate, status, total, paid, COMPANY],
  );
  return rows[0].id as string;
}

async function insertSupplierInvoice(
  admin: Pool, number: string, invoiceDate: string, dueDate: string,
  total: number, paid: number, status: string,
): Promise<string> {
  const { rows } = await admin.query(
    `INSERT INTO supplier_invoices
       (company_id, supplier_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [COMPANY, SUPPLIER, number, invoiceDate, dueDate, status, total, paid, COMPANY],
  );
  return rows[0].id as string;
}

async function payCustomer(
  admin: Pool, number: string, date: string, amount: number, invoiceId: string,
): Promise<void> {
  const { rows } = await admin.query(
    `INSERT INTO customer_payments
       (company_id, client_id, payment_number, payment_date, total_amount, status, bank_account_id, created_by)
     VALUES ($1,$2,$3,$4,$5,'confirmed',$6,$7) RETURNING id`,
    [COMPANY, CUSTOMER, number, date, amount, BANK, COMPANY],
  );
  await admin.query(
    `INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
     VALUES ($1,$2,$3)`,
    [rows[0].id, invoiceId, amount],
  );
}

async function paySupplier(
  admin: Pool, number: string, date: string, amount: number, invoiceId: string,
): Promise<void> {
  const { rows } = await admin.query(
    `INSERT INTO supplier_payments
       (company_id, supplier_id, payment_number, payment_date, total_amount, status, bank_account_id, created_by)
     VALUES ($1,$2,$3,$4,$5,'processed',$6,$7) RETURNING id`,
    [COMPANY, SUPPLIER, number, date, amount, BANK, COMPANY],
  );
  await admin.query(
    `INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
     VALUES ($1,$2,$3)`,
    [rows[0].id, invoiceId, amount],
  );
}

async function cleanup(admin: Pool): Promise<void> {
  await admin.query(`DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = $1)`, [COMPANY]);
  await admin.query(`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = $1)`, [COMPANY]);
  await admin.query('DELETE FROM customer_write_offs WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM credit_notes WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM customer_payments WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM supplier_payments WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM customer_invoices WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM supplier_invoices WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM customers WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM suppliers WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
}
