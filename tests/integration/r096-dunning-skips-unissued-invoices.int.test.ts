/**
 * R-096 — the dunning cron must never chase a draft or pending-approval
 * invoice. Folded into R-082 round 2 (Hein's reviewer measured it, high,
 * customer-facing): dunningCronService's candidate query filtered only
 * `status NOT IN ('cancelled', 'paid')`, so an overdue DRAFT invoice — never
 * sent to the customer — was handed to sendDunning like any issued one.
 *
 * Fix: the candidate query is routed through the shared rule
 * (shared/documentPopulation.documentInPopulationExpr), the same one R-082
 * routed every statement through, plus its own `COALESCE(status,'') != 'paid'`
 * leg — the shared rule counts 'paid' as issued (the ageing needs that), but
 * a fully paid invoice has nothing left to chase.
 *
 * Model: k053-dunning-cron-soft-deleted.int.test.ts — sendDunning is stubbed,
 * so nothing is actually mailed, and the assertion is on the invoice ids the
 * cron actually handed to the sender (ours only, since the fixture DB is
 * shared across files — see runDunningCron's companyId doc comment / R-036).
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

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `R096-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** A Wednesday, so the weekday-only gate never skips. */
const NOW = new Date('2026-06-17T08:00:00.000Z');

let customer: string;
let overdue = '';
let draft = '';
let pendingApproval = '';
let cancelled = '';
let paid = '';
let nullStatus = '';

describeIfDb('R-096 the dunning cron skips draft and pending-approval invoices', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number)
              VALUES (${COMPANY}::UUID, ${'R096 ' + TAG}, ${TAG})`;
    await sql`INSERT INTO dunning_settings (company_id, auto_send_enabled, min_outstanding_zar)
              VALUES (${COMPANY}::UUID, true, 0)`;
    await sql`INSERT INTO dunning_templates
                (company_id, name, days_overdue_min, days_overdue_max, subject_template,
                 body_template, tone, escalation_order, send_weekdays_only, active)
              VALUES (${COMPANY}::UUID, ${'R096 first ' + TAG}, 1, NULL, ${'Overdue'},
                      ${'Please pay'}, 'polite', 1, false, true)`;

    customer = ((await sql`
      INSERT INTO customers (company_id, name, email)
      VALUES (${COMPANY}::UUID, ${'cust ' + TAG}, ${TAG + '@test.local'})
      RETURNING id`) as { id: string }[])[0]!.id;

    // Every row shares the same overdue due date and outstanding amount —
    // only status differs, so status is the only thing that can explain the
    // candidate set.
    for (const [suffix, status, amountPaid] of [
      ['OVERDUE', 'overdue', 0],
      ['DRAFT', 'draft', 0],
      ['PA', 'pending_approval', 0],
      ['CANC', 'cancelled', 0],
      ['PAID', 'paid', 1000],
      ['NULL', null, 0],
    ] as const) {
      const rows = (await sql`
        INSERT INTO customer_invoices
          (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
           status, total_amount, amount_paid, created_by)
        VALUES
          (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-' + suffix},
           '2026-01-15', '2026-02-15', ${status}, 1000, ${amountPaid}, ${USER}::UUID)
        RETURNING id`) as { id: string }[];
      const id = rows[0]!.id;
      if (suffix === 'OVERDUE') overdue = id;
      if (suffix === 'DRAFT') draft = id;
      if (suffix === 'PA') pendingApproval = id;
      if (suffix === 'CANC') cancelled = id;
      if (suffix === 'PAID') paid = id;
      if (suffix === 'NULL') nullStatus = id;
    }
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

  it('premise: OVERDUE and NULL are outstanding; PAID is fully paid', async () => {
    const rows = (await sql`
      SELECT invoice_number, status, (total_amount - amount_paid)::numeric AS outstanding
      FROM customer_invoices WHERE company_id = ${COMPANY}::UUID ORDER BY invoice_number
    `) as { invoice_number: string; status: string | null; outstanding: string }[];
    expect(rows.map(r => [r.invoice_number, r.status, Number(r.outstanding)])).toEqual([
      [TAG + '-CANC', 'cancelled', 1000],
      [TAG + '-DRAFT', 'draft', 1000],
      [TAG + '-NULL', null, 1000],
      [TAG + '-OVERDUE', 'overdue', 1000],
      [TAG + '-PA', 'pending_approval', 1000],
      [TAG + '-PAID', 'paid', 0],
    ]);
  });

  it('dunns the overdue and null-status invoices; never draft, pending-approval, cancelled or paid', async () => {
    sent.length = 0;
    await runDunningCron({ now: NOW, companyId: COMPANY });

    const ours = sent.filter((s) => s.companyId === COMPANY).map((s) => s.invoiceId).sort();
    expect(ours).toEqual([nullStatus, overdue].sort());
    expect(ours).not.toContain(draft);
    expect(ours).not.toContain(pendingApproval);
    expect(ours).not.toContain(cancelled);
    expect(ours).not.toContain(paid);
  }, 60000);
});
