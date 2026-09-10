/**
 * R-059 round 5 (MEDIUM-1) — the AR/AP subledger snapshot selects the AGEING's
 * population, on a null-status document as on any other.
 *
 * `arSubledgerService`'s own header states the invariant this pins:
 *
 *   "The population is master's aging population exactly, and deliberately so:
 *    reconcile_subledger reports the aged total beside the subledger total, and
 *    two populations would make that comparison meaningless."
 *
 * Round 4 made every ageing site NULL-safe and left these two on the bare
 * `status NOT IN ('draft','cancelled')`, which is NULL for a null-status row.
 * The two populations then differed by exactly that document, and
 * `subledgerReconciliationService` books an unexplained difference it cannot
 * decompose (`reconcilingItemBuilders.aged_unexplained_difference`) — a
 * reconciliation inventing a difference out of a spelling, which is worse than
 * the figure it was correcting.
 *
 * Fixture, each side: R 1000 with a real status, and N 700 whose `status` is
 * NULL. Both unpaid, both raised before the as-at. Ageing total and subledger
 * total must both be 1700, and their DOCUMENT SETS must be identical — a total
 * can agree by luck, a set cannot.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getARSubledger } from '@/modules/accounting/services/ar/arSubledgerService';
import { getAPSubledger } from '@/modules/accounting/services/ap/apSubledgerService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `R059SL-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const TODAY = fmtDate(new Date());
const PAST = shift(-40);
const RAISED = shift(-100);
const DUE = shift(-90);

let customer = '';
let supplier = '';

describeIfDb('R-059 the subledger population is the ageing population, nulls included', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'R059SL ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    customer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
        due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR-R'}, ${RAISED}::date,
        ${DUE}::date, 'approved', 1000, 0, 0, 1000, 0, ${USER}::UUID),
             (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR-N'}, ${RAISED}::date,
        ${DUE}::date, NULL, 700, 0, 0, 700, 0, ${USER}::UUID)`;
    await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP-R'}, ${RAISED}::date, ${DUE}::date,
        'approved', 1000, 0, 1000, 0, ${USER}::UUID),
             (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP-N'}, ${RAISED}::date, ${DUE}::date,
        NULL, 700, 0, 700, 0, ${USER}::UUID)`;
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  it('the premise: one document on each side really carries a NULL status', async () => {
    const [n] = (await sql`
      SELECT (SELECT COUNT(*)::INT FROM customer_invoices
              WHERE company_id = ${COMPANY}::UUID AND status IS NULL) AS ar,
             (SELECT COUNT(*)::INT FROM supplier_invoices
              WHERE company_id = ${COMPANY}::UUID AND status IS NULL) AS ap
    `) as { ar: number; ap: number }[];
    expect(n).toEqual({ ar: 1, ap: 1 });
  });

  for (const asAt of [PAST, TODAY]) {
    const when = asAt === TODAY ? 'today' : 'a past date';

    it(`AR at ${when}: the ageing total and the subledger total are the same 1700`, async () => {
      const aged = (await getARAging(COMPANY, asAt)).reduce((s, b) => s + b.total + (b.disputed ?? 0), 0);
      const snap = await getARSubledger(COMPANY, asAt);
      expect(aged).toBeCloseTo(1700, 2);
      expect(snap.subledgerTotal).toBeCloseTo(1700, 2);
      expect(snap.documents).toHaveLength(2);
    });

    it(`AP at ${when}: the ageing total and the subledger total are the same 1700`, async () => {
      const aged = (await getAPAging(COMPANY, asAt)).reduce((s, b) => s + b.total + (b.disputed ?? 0), 0);
      const snap = await getAPSubledger(COMPANY, asAt);
      expect(aged).toBeCloseTo(1700, 2);
      expect(snap.subledgerTotal).toBeCloseTo(1700, 2);
      expect(snap.documents).toHaveLength(2);
    });
  }

  it('the sets agree document by document, not merely in total', async () => {
    const arIds = (await sql`
      SELECT id::TEXT FROM customer_invoices WHERE company_id = ${COMPANY}::UUID ORDER BY total_amount DESC
    `) as { id: string }[];
    const apIds = (await sql`
      SELECT id::TEXT FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID ORDER BY total_amount DESC
    `) as { id: string }[];
    const arSnap = await getARSubledger(COMPANY, TODAY);
    const apSnap = await getAPSubledger(COMPANY, TODAY);
    expect(arSnap.documents.map(d => d.id).sort()).toEqual(arIds.map(r => r.id).sort());
    expect(apSnap.documents.map(d => d.id).sort()).toEqual(apIds.map(r => r.id).sort());
  });
});
