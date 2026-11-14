/**
 * The data the Golden Paths specs of a later chunk read but do not make. Run as one serial job the specs a..n made it
 * on the way (b and c: customer invoices; d: the supplier '0GP-Golden-Supplier') and the later specs found it; a
 * hosted chunk starts from the seed alone, so chunks 3-6 timed out on an empty invoice list, an empty AR Aging card and
 * a supplier picker without Golden-Supplier (PR 1348, first run). This seeds them through the app, as the rest of
 * seed-demo-app.ts does.
 *
 * The customer invoices are approved (posted) and left unpaid, dated over the 10 complete months before the run, due
 * 30 days after: the oldest are in the 90+ bucket of the AR Age Analysis whatever day the run is on.
 */
import type { Client } from './seed-demo-app';

export const CUSTOMER_INVOICES = 12;
/** The name d-supplier-payment-ui and y5 look up (tests/e2e/golden-paths/_api.ts fixtureSupplier). */
export const FIXTURE_SUPPLIER = '0GP-Golden-Supplier';

const addDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/** `dateOf(i)` is the invoice date of invoice i (1-based), always a past day (seedDate in seed-demo-app.ts). */
export async function seedCustomerInvoices(api: Client, dateOf: (i: number) => string, customerIds: string[]): Promise<void> {
  if (customerIds.length === 0) throw new Error('seed: customer invoices need at least one customer');
  for (let i = 1; i <= CUSTOMER_INVOICES; i++) {
    const date = dateOf(i);
    const made = await api.post<{ id?: string; invoiceId?: string }>('/api/accounting/customer-invoices-create', {
      clientId: customerIds[i % customerIds.length],
      invoiceDate: date,
      dueDate: addDays(date, 30),
      taxRate: 15,
      notes: `DEMO-AR-${i}`,
      items: [{ description: `Demo AR line ${i}`, quantity: 1 + (i % 3), unitPrice: 200 + ((i * 53) % 800) }],
    });
    const id = made.id ?? made.invoiceId;
    if (!id) throw new Error(`seed: customer invoice ${i} came back without an id`);
    await api.post('/api/accounting/customer-invoices-detail', { id, action: 'approve' });
  }
}

export async function seedFixtureSupplier(api: Client): Promise<void> {
  await api.post('/api/accounting/suppliers-list', { name: FIXTURE_SUPPLIER, email: 'gp-golden-supplier@example.test', payment_terms: 30 });
}
