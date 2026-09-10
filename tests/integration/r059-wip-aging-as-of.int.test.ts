/**
 * R-059 class, practice module — getWipAging / getRevenuePipeline honour
 * `asOfDate`.
 *
 * Both used `asOfDate` for bucket arithmetic only, over TODAY's unbilled WIP
 * (`status = 'approved' AND billed_at IS NULL`). An entry approved after the
 * as-of date was counted, and one billed since was not.
 *
 *   W1  approved INV, never billed               1000
 *   W2  approved INV, billed BILL (status billed)  400  — datable, rewound
 *   W3  approved LATE, never billed               250
 *   W4  approved INV, status 'invoiced' by time-entries-invoice.ts, billed_at
 *       NULL                                        77  — NOT datable; out at
 *       every date, the documented understatement
 *
 *   BEFORE 0 · BETWEEN (after INV, before BILL) 1400 · AFTER (after BILL, before
 *   LATE) 1000 · TODAY 1250 — today is what the old query already returned.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getWipAging, getRevenuePipeline } from '@/modules/accounting/services/practice/practiceReportsService';
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
const BILL = shift(-50);
const LATE = shift(-20);

/** Noon SAST, so `::DATE` in the UTC session lands on the same calendar day. */
const at = (d: string) => `${d}T12:00:00+02:00`;

let client = '';

async function entry(status: string, total: number, approved: string, billed: string | null) {
  await sql`
    INSERT INTO time_entries (company_id, user_id, task_description, entry_date, hours, line_total,
      billable, status, practice_client_id, approved_at, billed_at)
    VALUES (${COMPANY}::UUID, ${USER}::UUID, ${TAG}, ${approved}::date, 1, ${total},
      true, ${status}, ${client}::UUID, ${at(approved)}::timestamptz,
      ${billed ? at(billed) : null}::timestamptz)`;
}

describeIfDb('R-059 WIP ageing and the revenue pipeline are as-of figures', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'R059W ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    client = ((await sql`INSERT INTO practice_clients (company_id, legal_name)
                         VALUES (${COMPANY}::UUID, ${'client ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    await entry('approved', 1000, INV, null);
    await entry('billed', 400, INV, BILL);
    await entry('approved', 250, LATE, null);
    await entry('invoiced', 77, INV, null);
  }, 60000);

  afterAll(async () => {
    await sql`DELETE FROM time_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM practice_clients WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 60000);

  const CASES: { label: string; asOf: () => string; total: number }[] = [
    { label: 'before any approval', asOf: () => shift(-120), total: 0 },
    { label: 'after approval, before billing', asOf: () => shift(-70), total: 1400 },
    { label: 'after billing, before the late approval', asOf: () => shift(-30), total: 1000 },
    { label: 'today (unchanged)', asOf: () => TODAY, total: 1250 },
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
    // W1 + W2 were approved 30 days before this as-of date: the 15-30 bucket.
    expect(row!.bucket15to30).toBeCloseTo(1400, 2);
    expect(row!.bucket0to7 + row!.bucket8to14 + row!.bucket31plus).toBeCloseTo(0, 2);
  });
});
