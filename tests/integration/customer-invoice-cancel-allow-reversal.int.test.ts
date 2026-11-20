/**
 * #1656 security fix (TOCTOU): whether a customer-invoice cancel needs Approve is decided under the service's row lock
 * from the locked row (gl_journal_entry_id IS NOT NULL), not from a status the route read earlier.
 *
 * The race: the route's view is a DRAFT (nothing to reverse); before the cancel takes its lock, another request
 * approves the invoice (journal posted). A cancel by a person WITHOUT Approve (allowReversal=false) must then be refused,
 * the journal left standing. With Approve it reverses as before.
 * Real PostgreSQL; the approval is held open in a second connection so the cancel is genuinely waiting on the lock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { openTx, postedReversalsOf, settle, setup, sleep, teardown, type Ctx } from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;

async function draftInvoice(): Promise<string> {
  const [i] = (await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${c.fx.companyId}::UUID, ${c.fx.customerId}::UUID, ${c.fx.customerId}::UUID, ${`ALLOWREV-${++c.seq}-${c.fx.tag}`},
      '2026-05-10'::DATE, '2026-05-10'::DATE, 'draft', 1000, 15, 150, 1150, 0, ${c.fx.userId}::UUID)
    RETURNING id`) as Row[];
  return String(i!.id);
}

const state = async (id: string) => ((await sql`
  SELECT status, gl_journal_entry_id FROM customer_invoices WHERE id = ${id}::UUID`) as Row[])[0]!;

describe.skipIf(!process.env.DATABASE_URL)('customer invoice cancel: allowReversal is decided under the row lock', () => {
  beforeAll(async () => {
    assertNotProductionDb('customer invoice cancel allowReversal');
    c = await setup('ALLOWREV');
  }, 120000);
  afterAll(async () => { await teardown(c); }, 120000);

  it('a draft cancelled without Approve still cancels (nothing to reverse)', async () => {
    const id = await draftInvoice();
    await inTx(c.fx, () => cancelCustomerInvoice(c.fx.companyId, id, c.fx.userId, { allowReversal: false }));
    expect((await state(id)).status).toBe('cancelled');
  });

  it('the invoice is approved between the route\'s draft read and the cancel\'s lock: refused without Approve, journal standing', async () => {
    const id = await draftInvoice();
    // The approval is in flight: it holds the invoice row and posts the journal, uncommitted.
    const approval = await openTx(c.fx, async () => {
      await sql`SELECT id FROM customer_invoices WHERE id = ${id}::UUID AND company_id = ${c.fx.companyId}::UUID FOR UPDATE`;
      await postCustomerInvoiceToGL(c.fx.companyId, id, c.fx.userId);
      await sql`UPDATE customer_invoices SET status = 'approved' WHERE id = ${id}::UUID`;
    });
    const cancel = settle(inTx(c.fx, () => cancelCustomerInvoice(c.fx.companyId, id, c.fx.userId, { allowReversal: false })));
    let finished = false;
    void cancel.then(() => { finished = true; });
    await sleep(800);
    expect(finished, 'the cancel must be waiting on the approval\'s row lock').toBe(false);
    await approval.commit();
    const out = await cancel;
    expect(out.ok).toBe(false);
    expect(out.ok ? '' : out.error).toMatch(/^ApprovePermissionError/);
    const after = await state(id);
    expect(after.status).toBe('approved');
    expect(after.gl_journal_entry_id).not.toBeNull();
    expect(await postedReversalsOf(c, String(after.gl_journal_entry_id))).toHaveLength(0);
  }, 60000);

  it('the same cancel with Approve reverses the journal', async () => {
    const id = await draftInvoice();
    await inTx(c.fx, async () => {
      await postCustomerInvoiceToGL(c.fx.companyId, id, c.fx.userId);
      await sql`UPDATE customer_invoices SET status = 'approved' WHERE id = ${id}::UUID`;
    });
    const je = String((await state(id)).gl_journal_entry_id);
    await inTx(c.fx, () => cancelCustomerInvoice(c.fx.companyId, id, c.fx.userId, { allowReversal: true }));
    expect((await state(id)).status).toBe('cancelled');
    expect(await postedReversalsOf(c, je)).toHaveLength(1);
  }, 60000);

  it('round 4 (B-M1): an approved invoice with NO journal (a Sage import) is refused without Approve, and cancels with it', async () => {
    const id = await draftInvoice();
    await sql`UPDATE customer_invoices SET status = 'approved' WHERE id = ${id}::UUID`;
    const refused = await settle(inTx(c.fx, () => cancelCustomerInvoice(c.fx.companyId, id, c.fx.userId, { allowReversal: false })));
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.error).toMatch(/^ApprovePermissionError/);
    expect((await state(id)).status).toBe('approved');
    await inTx(c.fx, () => cancelCustomerInvoice(c.fx.companyId, id, c.fx.userId, { allowReversal: true }));
    expect((await state(id)).status).toBe('cancelled');
  }, 60000);
});
