// tests/integration/ap-payment-document-backfill.int.test.ts
//
// Migration 615: the classification that decides which historical bank lines
// can have the supplier payment document that allocation never created before
// #340, and the function that mints it.
//
// ONE FILE, not two, and the fixture is shared: vitest runs test FILES in
// parallel, and two suites seeding and truncating one tenant's bank lines race
// each other into foreign-key failures. The seed itself lives in
// `tests/helpers/apBackfillFixture.ts`.
//
// What has to hold:
//   · every line is decided on the LEDGER, never on the bank row's word. A
//     journal that is not the two-legged DR Accounts Payable / CR Bank entry
//     for exactly that amount, a supplier name that does not resolve to one
//     live row, a journal two bank lines share — each is REPORTED under its
//     own outcome and skipped. None is approximated; none is passed over in
//     silence.
//   · the run writes ONE document per qualifying line and NOTHING else. No
//     journal, no allocation, no `amount_paid`: the DR AP / CR Bank entry
//     already exists and a second would double the debit.
//   · a run scoped to one company leaves every other tenant untouched.
//   · re-running creates nothing.
//   · rollback removes exactly what a batch created, and REFUSES once a human
//     has applied one of those payments to a bill.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import {
  AP2, BANK, BILL, CASES, CO, CO2, CO2_AMOUNT, CO2_TX, CREATE_TX, REFUND_TX, SUP, SUP2,
  cleanup, createdPaymentId, journalFor, ledgerShape, seed,
} from '../helpers/apBackfillFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const BATCH_1 = '00000000-0000-0000-0000-0000000bfb01';
const BATCH_2 = '00000000-0000-0000-0000-0000000bfb02';
const BATCH_3 = '00000000-0000-0000-0000-0000000bfb03';
const BATCH_4 = '00000000-0000-0000-0000-0000000bfb04';

describeIfDb('AP payment-document backfill (migration 615)', () => {
  let db: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts bank, journal and payment fixtures.');
    db = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(db);
    await seed(db);
  });

  afterAll(async () => {
    if (db) {
      await cleanup(db);
      await db.end();
    }
  });

  it('gives every line exactly one outcome, decided on the ledger', async () => {
    const res = await db.query(
      `SELECT bank_transaction_id::TEXT AS id, outcome
         FROM ap_payment_document_backfill_candidates WHERE company_id = $1::UUID`,
      [CO],
    );
    const got = new Map<string, string>(res.rows.map((r) => [r.id, r.outcome]));
    for (const [id, expected] of CASES) {
      expect(`${id}=${got.get(id)}`).toBe(`${id}=${expected}`);
    }
    // The refund is money in: a payment document for it would be cash the
    // company never paid.
    expect(got.has(REFUND_TX)).toBe(false);
    expect(got.size).toBe(CASES.length);
  });

  it('resolves the supplier within the company, never across tenants', async () => {
    // Both tenants use one trading name, and name is all the bank row carries.
    const res = await db.query(
      `SELECT supplier_id::TEXT AS supplier_id, outcome, amount
         FROM ap_payment_document_backfill_candidates
        WHERE bank_transaction_id = $1::UUID`,
      [CO2_TX],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.outcome).toBe('create');
    expect(res.rows[0]!.supplier_id).toBe(SUP2);
    expect(Number(res.rows[0]!.amount)).toBe(CO2_AMOUNT);
  });

  it('scopes each line to its own company', async () => {
    const res = await db.query(
      `SELECT company_id::TEXT AS company_id, COUNT(*)::INT AS n
         FROM ap_payment_document_backfill_candidates
        WHERE company_id = ANY($1::UUID[]) GROUP BY 1`,
      [[CO, CO2]],
    );
    const byCompany = new Map(res.rows.map((r) => [r.company_id, Number(r.n)]));
    expect(byCompany.get(CO)).toBe(CASES.length);
    expect(byCompany.get(CO2)).toBe(1);
  });

  it('writes nothing — reading the classification is the dry run', async () => {
    const before = await db.query(
      `SELECT (SELECT COUNT(*) FROM supplier_payments WHERE company_id = $1::UUID) AS p,
              (SELECT COUNT(*) FROM ap_payment_document_backfill WHERE company_id = $1::UUID) AS l`,
      [CO],
    );
    await db.query('SELECT * FROM ap_payment_document_backfill_candidates');
    const after = await db.query(
      `SELECT (SELECT COUNT(*) FROM supplier_payments WHERE company_id = $1::UUID) AS p,
              (SELECT COUNT(*) FROM ap_payment_document_backfill WHERE company_id = $1::UUID) AS l`,
      [CO],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('creates the document for the qualifying line and writes nothing else', async () => {
    const before = await ledgerShape(db);

    const run = await db.query(
      `SELECT result_outcome, result_reason, line_count
         FROM ap_backfill_supplier_payment_documents($1::UUID, $2::UUID)`,
      [CO, BATCH_1],
    );
    const created = run.rows.find((r) => r.result_outcome === 'created');
    expect(Number(created?.line_count ?? 0)).toBe(1);

    const pay = await db.query(
      `SELECT sp.supplier_id::TEXT, sp.payment_date::TEXT AS payment_date, sp.total_amount,
              sp.status, sp.payment_method, sp.gl_journal_entry_id::TEXT AS je, sp.reference,
              sp.payment_number, sp.bank_account_id::TEXT AS bank
         FROM supplier_payments sp
         JOIN ap_payment_document_backfill l ON l.supplier_payment_id = sp.id
        WHERE l.batch_id = $1::UUID AND l.outcome = 'created'`,
      [BATCH_1],
    );
    expect(pay.rows).toHaveLength(1);
    const p = pay.rows[0]!;
    expect(p.supplier_id).toBe(SUP);
    expect(Number(p.total_amount)).toBe(1000);
    expect(p.status).toBe('processed');
    expect(p.payment_method).toBe('eft');
    expect(p.bank).toBe(BANK);
    // The reference is the bank line: the audit trail back, and half the
    // idempotency.
    expect(p.reference).toBe(CREATE_TX);
    expect(p.je).toBe(journalFor(CREATE_TX));
    expect(p.payment_number).toMatch(/^SP-\d{4}-\d{5}$/);
    // Read as TEXT from pg. A raw Pool has no DATE type parser, so the driver
    // hands back a Date at LOCAL midnight and toISOString() re-reads it in UTC
    // — on this UTC+2 box that reports the day before.
    expect(p.payment_date).toBe('2026-03-15');

    // NOTHING ELSE MOVED, except the one payment row. A second journal would
    // double the AP debit and break the bank reconciliation; a touched
    // `amount_paid` would settle a bill nobody chose.
    expect(await ledgerShape(db)).toEqual({ ...before, payments: before.payments + 1 });
  });

  it('leaves every other tenant alone', async () => {
    // CO2 has its own qualifying line, against a supplier of the same NAME.
    const other = await db.query(
      `SELECT COUNT(*)::INT AS n FROM supplier_payments WHERE company_id = $1::UUID`,
      [CO2],
    );
    expect(Number(other.rows[0]!.n)).toBe(0);
    const log = await db.query(
      `SELECT COUNT(*)::INT AS n FROM ap_payment_document_backfill WHERE company_id = $1::UUID`,
      [CO2],
    );
    expect(Number(log.rows[0]!.n)).toBe(0);
    const stillOpen = await db.query(
      `SELECT outcome FROM ap_payment_document_backfill_candidates
        WHERE bank_transaction_id = $1::UUID`,
      [CO2_TX],
    );
    expect(stillOpen.rows[0]?.outcome).toBe('create');
  });

  it('creates nothing on a second run', async () => {
    const run = await db.query(
      `SELECT result_outcome, result_reason, line_count
         FROM ap_backfill_supplier_payment_documents($1::UUID, $2::UUID)`,
      [CO, BATCH_2],
    );
    expect(run.rows.some((r) => r.result_outcome === 'created')).toBe(false);
    const now = await db.query(
      `SELECT outcome FROM ap_payment_document_backfill_candidates
        WHERE bank_transaction_id = $1::UUID`,
      [CREATE_TX],
    );
    expect(now.rows[0]?.outcome).toBe('already_has_document');
  });

  it('serves the other tenant when it is the one asked for', async () => {
    const before = await ledgerShape(db, CO2, AP2);
    const run = await db.query(
      `SELECT result_outcome, line_count
         FROM ap_backfill_supplier_payment_documents($1::UUID, $2::UUID)`,
      [CO2, BATCH_3],
    );
    const created = run.rows.find((r) => r.result_outcome === 'created');
    expect(Number(created?.line_count ?? 0)).toBe(1);
    expect(await ledgerShape(db, CO2, AP2)).toEqual({ ...before, payments: before.payments + 1 });
    // And the first tenant gained nothing from the second tenant's run.
    const first = await db.query(
      `SELECT COUNT(*)::INT AS n FROM ap_payment_document_backfill
        WHERE batch_id = $1::UUID AND company_id = $2::UUID`,
      [BATCH_3, CO],
    );
    expect(Number(first.rows[0]!.n)).toBe(0);
  });

  it('survives a payment hard-deleted outside its own rollback', async () => {
    // The log's FK is ON DELETE SET NULL, so a payment removed by anything but
    // this migration's rollback leaves the log row behind with a null id. If
    // that orphan still occupied the unique index, the next run would die on a
    // duplicate key INSIDE the data-modifying CTE and abort the WHOLE tenant's
    // run over one line, with an error naming an index rather than a cause.
    const id = await createdPaymentId(db, BATCH_3);
    await db.query('DELETE FROM supplier_payments WHERE id = $1::UUID', [id]);

    const orphan = await db.query(
      `SELECT outcome, rolled_back_at IS NULL AS live, supplier_payment_id
         FROM ap_payment_document_backfill WHERE batch_id = $1::UUID AND outcome = 'created'`,
      [BATCH_3],
    );
    expect(orphan.rows[0]?.live).toBe(true);
    expect(orphan.rows[0]?.supplier_payment_id).toBeNull();

    const again = await db.query(
      `SELECT result_outcome, line_count
         FROM ap_backfill_supplier_payment_documents($1::UUID, $2::UUID)`,
      [CO2, BATCH_4],
    );
    const created = again.rows.find((r) => r.result_outcome === 'created');
    expect(Number(created?.line_count ?? 0)).toBe(1);
  });

  it('refuses to roll back a payment a human has since cancelled', async () => {
    // The OTHER arm of the refusal. A cancelled payment carries no allocation
    // row, so the allocation test alone leaves `sp.status <> 'processed'`
    // deletable — and rollback would then hard-delete a document somebody
    // deliberately cancelled, which is exactly the "someone else's work" this
    // refusal exists to protect.
    const id = await createdPaymentId(db, BATCH_1);
    await db.query(`UPDATE supplier_payments SET status = 'cancelled' WHERE id = $1::UUID`, [id]);
    await expect(
      db.query('SELECT * FROM ap_rollback_supplier_payment_document_backfill($1::UUID)', [BATCH_1]),
    ).rejects.toThrow(/Rollback refused/);
    const still = await db.query('SELECT 1 FROM supplier_payments WHERE id = $1::UUID', [id]);
    expect(still.rowCount).toBe(1);
    await db.query(`UPDATE supplier_payments SET status = 'processed' WHERE id = $1::UUID`, [id]);
  });

  it('refuses to roll back a payment allocated through the LEGACY table', async () => {
    // `supplier_payment_allocations` holds zero rows and has no writer today,
    // which is exactly why this needs a test: a guard whose justification is
    // "the day anything starts writing them" is the kind a future cleanup
    // deletes. It cascades on delete like the live table, so a rollback that
    // ignores it destroys those rows in silence. This is the ONLY arm of the
    // refusal that fires here — the payment stays `processed` and has no
    // `payment_allocations` row.
    const id = await createdPaymentId(db, BATCH_1);
    await db.query(
      `INSERT INTO supplier_payment_allocations (payment_id, invoice_id, amount_allocated)
       VALUES ($1::UUID, $2::UUID, 50)`,
      [id, BILL],
    );
    await expect(
      db.query('SELECT * FROM ap_rollback_supplier_payment_document_backfill($1::UUID)', [BATCH_1]),
    ).rejects.toThrow(/Rollback refused/);
    const still = await db.query('SELECT 1 FROM supplier_payments WHERE id = $1::UUID', [id]);
    expect(still.rowCount).toBe(1);
    await db.query('DELETE FROM supplier_payment_allocations WHERE payment_id = $1::UUID', [id]);
  });

  it('will not record a second live created row for one bank line', async () => {
    // `uq_ap_pdb_created_line` is the hard floor under idempotency — the one
    // that holds if every guard in the view is wrong at once. Nothing else in
    // this suite reaches it, so it is exercised directly.
    const id = await createdPaymentId(db, BATCH_1);
    await expect(db.query(
      `INSERT INTO ap_payment_document_backfill
         (batch_id, company_id, bank_transaction_id, supplier_payment_id, amount, outcome, reason)
       VALUES ($1::UUID, $2::UUID, $3::UUID, $4::UUID, 1000, 'created', 'duplicate')`,
      ['00000000-0000-0000-0000-0000000bfb09', CO, CREATE_TX, id],
    )).rejects.toThrow(/uq_ap_pdb_created_line/);
  });

  it('refuses to roll back a payment a human has since applied', async () => {
    const id = await createdPaymentId(db, BATCH_1);
    await db.query(
      `INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
       VALUES ($1::UUID, $2::UUID, 100)`,
      [id, BILL],
    );
    await expect(
      db.query('SELECT * FROM ap_rollback_supplier_payment_document_backfill($1::UUID)', [BATCH_1]),
    ).rejects.toThrow(/Rollback refused/);
    // And it refused whole: the payment is still there.
    const still = await db.query('SELECT 1 FROM supplier_payments WHERE id = $1::UUID', [id]);
    expect(still.rowCount).toBe(1);

    await db.query('DELETE FROM payment_allocations WHERE payment_id = $1::UUID', [id]);
  });

  it('rolls the batch back wholesale and returns the line to the queue', async () => {
    const res = await db.query(
      'SELECT * FROM ap_rollback_supplier_payment_document_backfill($1::UUID)',
      [BATCH_1],
    );
    expect(Number(res.rows[0]?.deleted_count)).toBe(1);
    expect(Number(res.rows[0]?.deleted_amount)).toBe(1000);

    const back = await db.query(
      `SELECT outcome FROM ap_payment_document_backfill_candidates
        WHERE bank_transaction_id = $1::UUID`,
      [CREATE_TX],
    );
    expect(back.rows[0]?.outcome).toBe('create');

    // The log survives the payment it recorded, and says so.
    const log = await db.query(
      `SELECT rolled_back_at IS NOT NULL AS rolled_back, supplier_payment_id
         FROM ap_payment_document_backfill
        WHERE batch_id = $1::UUID AND outcome = 'created'`,
      [BATCH_1],
    );
    expect(log.rows[0]?.rolled_back).toBe(true);
    expect(log.rows[0]?.supplier_payment_id).toBeNull();

    // The OTHER tenant's batch is untouched by this batch's rollback.
    const other = await db.query(
      `SELECT COUNT(*)::INT AS n FROM supplier_payments WHERE company_id = $1::UUID`,
      [CO2],
    );
    expect(Number(other.rows[0]!.n)).toBe(1);
  });
});
