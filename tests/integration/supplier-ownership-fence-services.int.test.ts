// tests/integration/supplier-ownership-fence-services.int.test.ts
//
// R-068, the paths no route test can see.
//
// 1. The supplier-expectation cron (`/api/cron/expectations-daily`) runs with
//    no `withAuth`, as the connection role, outside RLS. It learns a cadence
//    for every supplier_id on the company's bills and, when the company opts
//    in, emails or WhatsApps the supplier on the alert. Under RLS a foreign
//    supplier joins to nothing; here it joins to company B's row — B's
//    supplier's email and name — and the send writes that address into
//    company A's own alert row (`chase_to_address`), which A can read. That is
//    R-066's shape on the supplier side. The rows are planted directly: they
//    stand for bills written before the create paths were fenced.
// 2. bankRulesService.updateRule: the tenant FK already refuses a foreign
//    supplier, so only the ERROR TYPE shows whether the fence ran first.
// 3. The fence's read is savepointed: a malformed id leaves the request
//    transaction usable.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ids, setUpFixture, tearDownFixture, type Fixture } from './supplier-ownership-fence.helpers';

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({ success: true })),
  sendWhatsAppMessage: vi.fn(async () => ({ sent: true })),
}));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('@/modules/accounting/services/capture/whatsAppReplyService', () => ({
  sendWhatsAppMessage: mocks.sendWhatsAppMessage,
}));

import { recomputeAllForCompany } from '@/modules/accounting/services/capture/expectationEngineService';
import { listAlerts, sendEmailChase } from '@/modules/accounting/services/capture/missingInvoiceChaseService';
import { sendWhatsAppChase } from '@/modules/accounting/services/capture/whatsAppChaseService';
import { updateRule } from '@/modules/accounting/services/bank/bankRulesService';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import {
  assertSupplierInCompany, SupplierNotInCompanyError,
} from '@/modules/accounting/services/core/contactDirectoryService';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

describeIfDb('R-068 — supplier ids on paths outside the route fences', () => {
  let fx: Fixture;
  const { A, SUP_A, SUP_B } = ids;
  let alertB = '';
  let alertA = '';

  /** A request transaction of the shape `withAuth` opens, as the connection role. */
  async function inTx<T>(fn: () => Promise<T>): Promise<T> {
    const c = await fx.pool.connect();
    await c.query('BEGIN');
    try {
      const out = await als.run({ client: c, userId: ids.USER, companyId: A, claims: {} } as never, fn);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  }

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('R068 svc');
    const q = (text: string, params: unknown[]) => fx.pool.query(text, params);
    await q('UPDATE companies SET whatsapp_chase_enabled = true WHERE id = $1', [A]);
    await q("UPDATE suppliers SET whatsapp_number = '+27820000000' WHERE id = ANY($1::uuid[])", [[SUP_A, SUP_B]]);
    for (const m of [1, 2, 3]) {
      await q(`INSERT INTO supplier_invoices (company_id, invoice_number, supplier_id, invoice_date,
          subtotal, tax_amount, total_amount, status, created_by)
        VALUES ($1, $2, $3, CURRENT_DATE - ($4 || ' months')::interval, 100, 15, 115, 'approved', $5)`,
      [A, `R068-PLANT-${m}`, SUP_B, m, ids.USER]);
    }
    const alert = async (s: string) => (await q(`INSERT INTO expected_invoice_alerts
        (company_id, supplier_id, expected_by, expected_amount)
      VALUES ($1, $2, CURRENT_DATE - 10, 115) RETURNING id`, [A, s])).rows[0].id as string;
    alertB = await alert(SUP_B);
    alertA = await alert(SUP_A);
  });
  afterAll(() => tearDownFixture(fx?.pool));

  it('recompute learns no expectation for a foreign supplier on the company\'s bills', async () => {
    await recomputeAllForCompany(A);
    expect(await fx.count(
      'SELECT count(*) AS n FROM supplier_expectations WHERE company_id = $1 AND supplier_id = $2',
      [A, SUP_B])).toBe(0);
  });

  it.each([undefined, 'pending'] as const)('the alert list (filter %s) does not render the foreign supplier', async (f) => {
    const rows = await listAlerts(A, f);
    expect(JSON.stringify(rows)).not.toContain('b@r068.test');
    expect(JSON.stringify(rows)).not.toContain('R068 Supplier B');
    expect(rows.map((r) => r.supplierId)).toContain(SUP_A);
  });

  it('an email chase on the planted alert sends nothing and copies no address into it', async () => {
    mocks.sendEmail.mockClear();
    expect((await sendEmailChase(A, alertB, ids.USER)).sent).toBe(false);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(await fx.count(
      'SELECT count(*) AS n FROM expected_invoice_alerts WHERE id = $1 AND chase_to_address IS NOT NULL',
      [alertB])).toBe(0);
  });

  it('a WhatsApp chase on the planted alert sends nothing', async () => {
    mocks.sendWhatsAppMessage.mockClear();
    expect((await sendWhatsAppChase(A, alertB, ids.USER)).sent).toBe(false);
    expect(mocks.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('still chases company A\'s own supplier, by email and by WhatsApp', async () => {
    mocks.sendEmail.mockClear();
    mocks.sendWhatsAppMessage.mockClear();
    expect((await sendWhatsAppChase(A, alertA, ids.USER)).sent).toBe(true);
    expect(mocks.sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    await fx.pool.query("UPDATE expected_invoice_alerts SET status = 'pending' WHERE id = $1", [alertA]);
    expect((await sendEmailChase(A, alertA, ids.USER)).sent).toBe(true);
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@r068.test' }));
  });

  it('createSupplierInvoice itself refuses a foreign supplier — the MCP tools reach it past no route', async () => {
    const input = { invoiceNumber: 'R068-SVC', invoiceDate: '2026-09-01',
      items: [{ description: 'Fence', quantity: 1, unitPrice: 10 }] };
    await expect(inTx(() => createSupplierInvoice(A, { ...input, supplierId: SUP_B }, ids.USER)))
      .rejects.toBeInstanceOf(SupplierNotInCompanyError);
    const bill = await inTx(() => createSupplierInvoice(A, { ...input, supplierId: SUP_A }, ids.USER));
    expect(bill.supplierId).toBe(SUP_A);
  });

  it('bank rule update refuses a foreign supplier with the typed error, not the FK violation', async () => {
    await expect(inTx(() => updateRule(A, ids.RULE, { supplierId: SUP_B })))
      .rejects.toBeInstanceOf(SupplierNotInCompanyError);
    const rule = await inTx(() => updateRule(A, ids.RULE, { supplierId: SUP_A }));
    expect(rule.supplierId).toBe(SUP_A);
  });

  it('a malformed supplier id is refused and leaves the request transaction usable', async () => {
    const after = await inTx(async () => {
      await expect(assertSupplierInCompany(A, 'not-a-uuid')).rejects.toBeInstanceOf(SupplierNotInCompanyError);
      await assertSupplierInCompany(A, SUP_A);
      return (await sql`SELECT 1 AS n`) as Array<{ n: number }>;
    });
    expect(after[0]?.n).toBe(1);
  });
});
