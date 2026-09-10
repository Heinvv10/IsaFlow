/**
 * R-059 class, practice module — getWipAging / getRevenuePipeline honour
 * `asOfDate` (practice/wipAsOf).
 *
 * Both used `asOfDate` for bucket arithmetic only, over TODAY's unbilled WIP
 * (`status = 'approved' AND billed_at IS NULL`). An entry approved after the
 * as-of date was counted, and one that had left since was not.
 *
 *   W1  approved INV, never billed                       1000
 *   W2  approved INV, billed BILL (status billed)         400  — exit billed_at
 *   W3  approved LATE, never billed                       250
 *   W4  approved INV, status 'invoiced', no invoice_id     77  — undated exit:
 *       out at every date
 *   W5  approved INV, written off WO (not_billable)       300  — exit written_off_at
 *   W6  approved INV, invoiced by an invoice dated IVD    200  — exit invoice_date
 *   W7  approved with NO approved_at (the approveEntries
 *       path), work dated WORK                            150  — in from WORK
 *   W8  NO approved_at, status 'invoiced' (IVD)            60  — no evidence it
 *       was ever WIP: out at every date
 *   W9  approved INV, invoiced by an invoice dated in the
 *       FUTURE                                             40  — in at every past
 *       date from INV, out today
 *   W10 NO approved_at, work dated in the FUTURE           15  — in today (as it
 *       always was), at no past date
 *
 *   BEFORE 0 · INV (the approval day) 1940 · BETWEEN 1940 · BILL (the billing
 *   day) 1690 · IVD (the invoice day) 1490 · WO (the write-off day) 1190 ·
 *   AFTER 1190 · TODAY 1415 — today is what the pre-branch query returned
 *   (W1 + W3 + W7 + W10); round 1 of this fix dropped W7 and W10 there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getWipAging, getRevenuePipeline } from '@/modules/accounting/services/practice/practiceReportsService';
import { approveEntries } from '@/modules/accounting/services/core/timeTrackingService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `R059W-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const TODAY = fmtDate(new Date());
const INV = shift(-100);
const WORK = shift(-60);
const BILL = shift(-50);
const IVD = shift(-45);
const WO = shift(-40);
const LATE = shift(-20);

/** Noon SAST, so `::DATE` in the UTC session lands on the same calendar day. */
const at = (d: string) => `${d}T12:00:00+02:00`;

let client = '';
let customer = '';

interface Entry {
  status: string; total: number; approved: string | null; billed?: string;
  writtenOff?: string; invoiceDate?: string; work?: string;
}

async function entry(e: Entry): Promise<string> {
  let invoice: string | null = null;
  if (e.invoiceDate) {
    invoice = ((await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
        status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-' + randomUUID().slice(0, 8)},
        ${e.invoiceDate}::date, 'approved', ${e.total}, 0, 0, ${e.total}, 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
  }
  return ((await sql`
    INSERT INTO time_entries (company_id, user_id, task_description, entry_date, hours, line_total,
      billable, status, practice_client_id, approved_at, billed_at, written_off_at, invoice_id, invoiced)
    VALUES (${COMPANY}::UUID, ${USER}::UUID, ${TAG}, ${e.work ?? e.approved ?? INV}::date, 1, ${e.total},
      true, ${e.status}, ${client}::UUID, ${e.approved ? at(e.approved) : null}::timestamptz,
      ${e.billed ? at(e.billed) : null}::timestamptz, ${e.writtenOff ? at(e.writtenOff) : null}::timestamptz,
      ${invoice}::UUID, ${e.status === 'invoiced'})
    RETURNING id`) as { id: string }[])[0]!.id;
}

describeIfDb('R-059 WIP ageing and the revenue pipeline are as-of figures', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'R059W ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    client = ((await sql`INSERT INTO practice_clients (company_id, legal_name)
                         VALUES (${COMPANY}::UUID, ${'client ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    customer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'cust ' + TAG})
                           RETURNING id`) as { id: string }[])[0]!.id;
    await entry({ status: 'approved', total: 1000, approved: INV });
    await entry({ status: 'billed', total: 400, approved: INV, billed: BILL });
    await entry({ status: 'approved', total: 250, approved: LATE });
    await entry({ status: 'invoiced', total: 77, approved: INV });
    await entry({ status: 'not_billable', total: 300, approved: INV, writtenOff: WO });
    await entry({ status: 'invoiced', total: 200, approved: INV, invoiceDate: IVD });
    await entry({ status: 'approved', total: 150, approved: null, work: WORK });
    await entry({ status: 'invoiced', total: 60, approved: null, work: INV, invoiceDate: IVD });
    await entry({ status: 'invoiced', total: 40, approved: INV, invoiceDate: shift(10) });
    await entry({ status: 'approved', total: 15, approved: null, work: shift(5) });
  }, 60000);

  afterAll(async () => {
    await sql`DELETE FROM time_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM practice_clients WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 60000);

  const CASES: { label: string; asOf: () => string; total: number }[] = [
    { label: 'before any approval', asOf: () => shift(-120), total: 0 },
    { label: 'on the approval day', asOf: () => INV, total: 1940 },
    { label: 'after approval, before any exit', asOf: () => shift(-70), total: 1940 },
    { label: 'on the billing day', asOf: () => BILL, total: 1690 },
    { label: 'on the invoice day', asOf: () => IVD, total: 1490 },
    { label: 'on the write-off day', asOf: () => WO, total: 1190 },
    { label: 'after every past exit, before the late approval', asOf: () => shift(-30), total: 1190 },
    { label: 'today (the pre-branch figure)', asOf: () => TODAY, total: 1415 },
  ];

  for (const c of CASES) {
    it(`${c.label}: WIP ageing and the pipeline both report R${c.total}`, async () => {
      const rows = await getWipAging(COMPANY, { asOfDate: c.asOf() });
      expect(rows.reduce((s, r) => s + r.total, 0)).toBeCloseTo(c.total, 2);
      const pipe = await getRevenuePipeline(COMPANY, { asOfDate: c.asOf() });
      expect(pipe.totalApproved).toBeCloseTo(c.total, 2);
    });
  }

  it('the rewound entry is aged from its approval date at the in-between date', async () => {
    const [row] = await getWipAging(COMPANY, { asOfDate: shift(-70) });
    // W1 W2 W5 W6 W9 were approved 30 days before this as-of date: the 15-30 bucket.
    expect(row!.bucket15to30).toBeCloseTo(1940, 2);
    expect(row!.bucket0to7 + row!.bucket8to14 + row!.bucket31plus).toBeCloseTo(0, 2);
  });

  it('approveEntries now dates the approval, so the entry is WIP from today and not before', async () => {
    const [row] = (await sql`
      INSERT INTO time_entries (company_id, user_id, task_description, entry_date, hours, line_total,
        billable, status, practice_client_id)
      VALUES (${COMPANY}::UUID, ${USER}::UUID, ${TAG}, ${shift(-90)}::date, 1, 25, true, 'submitted', ${client}::UUID)
      RETURNING id`) as { id: string }[];
    try {
      expect(await approveEntries(COMPANY, [row!.id])).toBe(1);
      const [te] = (await sql`SELECT approved_at FROM time_entries
                              WHERE id = ${row!.id}::UUID AND company_id = ${COMPANY}::UUID`) as { approved_at: unknown }[];
      expect(te!.approved_at).not.toBeNull();
      expect((await getRevenuePipeline(COMPANY, { asOfDate: TODAY })).totalApproved).toBeCloseTo(1440, 2);
      expect((await getRevenuePipeline(COMPANY, { asOfDate: shift(-30) })).totalApproved).toBeCloseTo(1190, 2);
    } finally {
      await sql`DELETE FROM time_entries WHERE id = ${row!.id}::UUID AND company_id = ${COMPANY}::UUID`;
    }
  });
});
