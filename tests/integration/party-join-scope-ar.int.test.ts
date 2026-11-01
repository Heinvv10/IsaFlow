// tests/integration/party-join-scope-ar.int.test.ts
//
// AR readers on a document of company A naming company B's customer. Same shape
// as party-join-scope-ap: the row stays, B's name does not, A's own row keeps A's
// name.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';

const mail = vi.hoisted(() => ({ sendEmail: vi.fn(async (_m: { html: string }) => ({ success: false, error: 'not sent' })) }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: mail.sendEmail }));

import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropAgingScope, newAgingScope, seedAgingScope } from '../helpers/agingScopeFixture';
import { docNo, dropPartyDocs, seedPartyDocs, type PartyDocs } from '../helpers/partyJoinScopeFixture';
import { UNKNOWN_CUSTOMER } from '@/modules/accounting/services/ar/arAgingInvoices';
import { getCustomerPaymentById, getCustomerPayments } from '@/modules/accounting/services/ar/customerPaymentService';
import { getDeliveryNote, getDeliveryNotes } from '@/modules/accounting/services/ar/deliveryNoteService';
import { listSends } from '@/modules/accounting/services/ar/dunningAdmin';
import { listOverrides } from '@/modules/accounting/services/ar/dunningOverridesService';
import { getInvoicePdfFilename } from '@/modules/accounting/services/ar/invoicePdfService';
import { getRecurringInvoices } from '@/modules/accounting/services/ar/recurringInvoiceService';
import { getSalesOrder, getSalesOrders } from '@/modules/accounting/services/ar/salesOrderService';
import { getWriteOffs } from '@/modules/accounting/services/ar/writeOffService';
import { sendInvoiceEmail } from '@/modules/accounting/services/core/emailNotificationService';
import { getTimeEntries, getTimeEntry } from '@/modules/accounting/services/core/timeTrackingService';
import { getAdjustments } from '@/modules/accounting/services/items/adjustmentService';
import { getTimeSummary, getUninvoicedEntries } from '@/modules/accounting/services/reports/timeTrackingReportService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const S = newAgingScope();
const OK_NAME = `Tenant A Customer ${S.TAG}`;
const OK_SUPPLIER = `Tenant A Supplier ${S.TAG}`;

describeIfDb('AR readers keep another tenant\'s customer name out', () => {
  let admin: Pool;
  let docs: PartyDocs;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes company, customer and document fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await seedAgingScope(admin, S);
    docs = await seedPartyDocs(admin, S);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await dropPartyDocs(admin, S);
    await dropAgingScope(admin, S);
    await admin.end();
  }, 60000);

  /** A list: the poisoned row is there, B's name is not, and A's row kept A's name. */
  const both = (result: unknown, kind: string, name = OK_NAME) => {
    const json = JSON.stringify(result);
    expect(json).toContain(docNo(S, kind, 'POISONED'));
    expect(json).toContain(docNo(S, kind, 'OK'));
    expect(json).not.toContain(S.LEAK_CUSTOMER);
    expect(json).not.toContain(S.LEAK_SUPPLIER);
    expect(json).toContain(name);
  };
  /** One document or a filtered list: it is there, without B's name. */
  const poisoned = (result: unknown, kind: string) => {
    const json = JSON.stringify(result);
    expect(json).toContain(docNo(S, kind, 'POISONED'));
    expect(json).not.toContain(S.LEAK_CUSTOMER);
    expect(json).not.toContain(S.LEAK_SUPPLIER);
  };

  it.each([
    ['no filter', () => getCustomerPayments(S.A)],
    ['status', () => getCustomerPayments(S.A, { status: 'confirmed' } as never)],
  ])('getCustomerPayments (%s)', async (_l, call) => both(await call(), 'CP'));

  it('getCustomerPayments (clientId) and getCustomerPaymentById', async () => {
    poisoned(await getCustomerPayments(S.A, { clientId: S.CUST_B } as never), 'CP');
    poisoned(await getCustomerPaymentById(S.A, docs.POISONED.customerPayment), 'CP');
  });

  it.each([
    ['no filter', () => getDeliveryNotes(S.A)],
    ['status', () => getDeliveryNotes(S.A, { status: 'draft' })],
  ])('getDeliveryNotes (%s)', async (_l, call) => both(await call(), 'DN'));

  it('getDeliveryNote', async () => poisoned(await getDeliveryNote(S.A, docs.POISONED.deliveryNote), 'DN'));

  it.each([
    ['no filter', () => getSalesOrders(S.A)],
    ['status', () => getSalesOrders(S.A, { status: 'draft' })],
  ])('getSalesOrders (%s)', async (_l, call) => both(await call(), 'SO'));

  it('getSalesOrder', async () => poisoned(await getSalesOrder(S.A, docs.POISONED.salesOrder), 'SO'));

  it.each([
    ['search', {}],
    ['search + status', { status: 'draft' }],
  ])('getSalesOrders (%s) cannot be searched by B\'s customer name', async (_l, extra) => {
    const { orders, total } = await getSalesOrders(S.A, { search: S.LEAK_CUSTOMER, ...extra });
    expect(orders).toEqual([]);
    expect(total).toBe(0);
  });

  it.each([
    ['no filter', () => getWriteOffs(S.A)],
    ['status', () => getWriteOffs(S.A, { status: 'draft' } as never)],
  ])('getWriteOffs (%s)', async (_l, call) => both(await call(), 'WO'));

  it('getWriteOffs (clientId)', async () => poisoned(await getWriteOffs(S.A, { clientId: S.CUST_B } as never), 'WO'));

  it.each([
    ['no filter', () => getRecurringInvoices(S.A)],
    ['status', async () => getRecurringInvoices(S.A, { status: 'active' } as never)],
  ])('getRecurringInvoices (%s)', async (_l, call) => both(await call(), 'RI'));

  it('getRecurringInvoices (clientId)', async () => poisoned(await getRecurringInvoices(S.A, { clientId: S.CUST_B } as never), 'RI'));

  it('getTimeEntries and getTimeEntry', async () => {
    both(await getTimeEntries(S.A), 'TE');
    poisoned(await getTimeEntry(S.A, docs.POISONED.timeEntry), 'TE');
  });

  it('getUninvoicedEntries, whole company and by customer', async () => {
    both(await getUninvoicedEntries(S.A), 'TE');
    poisoned(await getUninvoicedEntries(S.A, S.CUST_B), 'TE');
  });

  it('getTimeSummary keeps the foreign customer\'s hours under UNKNOWN_CUSTOMER, apart from entries with no customer', async () => {
    await admin.query(`INSERT INTO time_entries (company_id, user_id, task_description, hours, status, billable, invoiced, rate, entry_date)
      VALUES ($1,$2,$3,5,'draft',false,false,100,'2026-05-03')`, [S.A, S.USER, `${S.TAG} no customer`]);
    const summary = await getTimeSummary(S.A);
    expect(JSON.stringify(summary)).not.toContain(S.LEAK_CUSTOMER);
    expect(summary.byCustomer.find((c) => c.customerId === S.CUST_B)).toMatchObject({ customerName: UNKNOWN_CUSTOMER, hours: 2, value: 200 });
    expect(summary.byCustomer.find((c) => c.customerId === 'none')).toMatchObject({ customerName: 'No Customer', hours: 5, value: 500 });
    expect(summary.byCustomer.find((c) => c.customerId === S.CUST_A)).toMatchObject({ customerName: OK_NAME, hours: 2 });
    expect(summary.byCustomer).toHaveLength(3);
  });

  it.each([
    ['no filter', () => getAdjustments(S.A)],
    ['customer', () => getAdjustments(S.A, { entityType: 'customer' } as never)],
  ])('getAdjustments (%s), customer side', async (_l, call) => both(await call(), 'ADJC'));

  it.each([
    ['no filter', () => getAdjustments(S.A)],
    ['supplier', () => getAdjustments(S.A, { entityType: 'supplier' } as never)],
  ])('getAdjustments (%s), supplier side', async (_l, call) => both(await call(), 'ADJS', OK_SUPPLIER));

  it('listSends keeps the send under UNKNOWN_CUSTOMER', async () => {
    const sends = await listSends(S.A);
    const bad = sends.find((r) => r.customer_invoice_id === docs.POISONED.arInvoice);
    expect(bad?.customer_name).toBe(UNKNOWN_CUSTOMER);
    expect(sends.find((r) => r.customer_invoice_id === docs.OK.arInvoice)?.customer_name).toBe(OK_NAME);
  });

  it('listOverrides keeps the override under UNKNOWN_CUSTOMER', async () => {
    const rows = await listOverrides(S.A);
    expect(rows.find((r) => r.customer_id === S.CUST_B)?.customer_name).toBe(UNKNOWN_CUSTOMER);
    expect(rows.find((r) => r.customer_id === S.CUST_A)?.customer_name).toBe(OK_NAME);
  });

  it('the invoice PDF filename does not carry B\'s customer', async () => {
    const slug = S.LEAK_CUSTOMER.replace(/[^A-Za-z0-9]+/g, '-');
    expect(await getInvoicePdfFilename(S.A, docs.POISONED.arInvoice)).not.toContain(slug.slice(0, 20));
    expect(await getInvoicePdfFilename(S.A, docs.OK.arInvoice)).toContain('Tenant-A-Customer');
  });

  it('the invoice email is not addressed to B\'s customer', async () => {
    await sendInvoiceEmail(S.A, docs.POISONED.arInvoice, 'x@test.local');
    const { html } = mail.sendEmail.mock.calls[0]![0];
    expect(html).not.toContain(S.LEAK_CUSTOMER);
    expect(html).toContain('Valued Customer');
  }, 30000);
});
