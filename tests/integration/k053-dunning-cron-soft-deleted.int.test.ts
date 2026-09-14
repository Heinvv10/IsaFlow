/**
 * K-053 — the dunning CRON must not chase a soft-deleted invoice.
 *
 * dunningService.loadInvoiceCtx is covered by k053-soft-delete-chase-surfaces;
 * the cron carries the same predicate in its own candidate query and was left
 * untested through rounds 2 and 3, because runDunningCron walks every company
 * with auto_send_enabled and hands each match to sendDunning, which sends mail.
 *
 * So sendDunning is STUBBED here. Nothing is sent, and the assertion is on the
 * invoice ids the cron handed it — which is the real question, and a stronger
 * one than the summary counters, since those are global to the run while the
 * ids are ours.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const sent: { companyId: string; invoiceId: string }[] = [];

vi.mock('@/modules/accounting/services/ar/dunningService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/accounting/services/ar/dunningService')>();
  return {
    ...actual,
    sendDunning: vi.fn(async (args: { companyId: string; invoiceId: string }) => {
      sent.push({ companyId: args.companyId, invoiceId: args.invoiceId });
      return { emailStatus: 'sent' as const, emailError: null };
    }),
  };
});

const { runDunningCron } = await import('@/modules/accounting/services/ar/dunningCronService');

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K053CRON-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** A Wednesday, so the weekday-only gate never skips. */
const NOW = new Date('2026-06-17T08:00:00.000Z');

let customer: string;
let liveInvoice: string;
let deletedInvoice: string;

describeIfDb('K-053 the dunning cron skips soft-deleted invoices', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number)
              VALUES (${COMPANY}::UUID, ${'K053CRON ' + TAG}, ${TAG})`;
    await sql`INSERT INTO dunning_settings (company_id, auto_send_enabled, min_outstanding_zar)
              VALUES (${COMPANY}::UUID, true, 0)`;
    await sql`INSERT INTO dunning_templates
                (company_id, name, days_overdue_min, days_overdue_max, subject_template,
                 body_template, tone, escalation_order, send_weekdays_only, active)
              VALUES (${COMPANY}::UUID, ${'K053 first ' + TAG}, 1, NULL, ${'Overdue'},
                      ${'Please pay'}, 'polite', 1, false, true)`;

    customer = ((await sql`
      INSERT INTO customers (company_id, name, email)
      VALUES (${COMPANY}::UUID, ${'cust ' + TAG}, ${TAG + '@test.local'})
      RETURNING id`) as { id: string }[])[0]!.id;

    const rows = (await sql`
      INSERT INTO customer_invoices
        (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
         status, total_amount, amount_paid, created_by, deleted_at)
      VALUES
        (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-LIVE'}, '2026-01-15', '2026-02-15', 'overdue', 1000, 0, ${USER}::UUID, NULL),
        (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-DEL'},  '2026-01-15', '2026-02-15', 'overdue', 750,  0, ${USER}::UUID, NOW())
      RETURNING id, invoice_number`) as { id: string; invoice_number: string }[];
    liveInvoice = rows.find((r) => r.invoice_number.endsWith('-LIVE'))!.id;
    deletedInvoice = rows.find((r) => r.invoice_number.endsWith('-DEL'))!.id;
  }, 60000);

  afterAll(async () => {
    await sql`DELETE FROM dunning_sends WHERE customer_invoice_id IN
                (SELECT id FROM customer_invoices WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM dunning_templates WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM dunning_settings WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
  }, 60000);

  it('hands the live invoice to the sender and never the deleted one', async () => {
    sent.length = 0;
    await runDunningCron({ now: NOW });

    const ours = sent.filter((s) => s.companyId === COMPANY).map((s) => s.invoiceId);
    expect(ours).toContain(liveInvoice);
    expect(ours).not.toContain(deletedInvoice);
    expect(ours).toHaveLength(1);
  }, 60000);
});
