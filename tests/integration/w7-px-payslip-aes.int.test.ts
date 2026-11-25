/**
 * Wave 7 PX (W15, W16; migration 1052; Hein's rulings 2 and 17): the emailed payslip, through the real send route
 * (withAuth, app_user, RLS) built with a CAPTURE mailer, on two tenants. Nothing here can send (pe-payslip-email.helpers).
 * Claims:
 *  - the attachment is AES-256 (V 5, R 6, AESV3), opens with the ID number only;
 *  - every row (claim and outcome) records pdf_sha256 = the hash of the exact bytes attached AND plaintext_sha256 = the
 *    hash of the deterministic render; a resend is a new encryption (new pdf_sha256) of the same render (same
 *    plaintext_sha256); app_user writes the new column (1052's column GRANT) and the CHECK refuses a malformed value;
 *  - a server that cannot encrypt (no qpdf on PATH) refuses the whole request 503 ENCRYPTION_UNAVAILABLE: nothing
 *    sent, no row, no audit;
 *  - W16: the component types are frozen into payslip_snapshot at approval; re-typing a component afterwards does not
 *    move a final slip's item (the emailed PDF itemises by the frozen type);
 *  - tenant b sees none of a's rows; every captured recipient is @example.invalid.
 * Disposable DB only (rig -> assertDisposable).
 */
import { createHash } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig } from './brkr.helpers';
import {
  approvedRun, asAppUser, audits, captured, cleanup, enablePlatform, person, putSetting, reason, send, type R,
} from './pe-payslip-email.helpers';

let a: R;
let b: R;
let run = '';
let employee = '';
const ID = '8001015009087';

async function opens(pdf: Buffer, password?: string): Promise<string> {
  const { PDFParse } = (await import('pdf-parse')) as unknown as {
    PDFParse: new (o: { data: Buffer; password?: string }) => { getText(): Promise<{ text: string }> };
  };
  return (await new PDFParse({ data: Buffer.from(pdf), ...(password ? { password } : {}) }).getText()).text.replace(/\s+/g, ' ');
}
const sha = (x: Buffer) => createHash('sha256').update(x).digest('hex');
const rows = async (r: R) => (await r.pool.query(
  `SELECT claim, pdf_sha256, plaintext_sha256, status FROM payslip_deliveries WHERE company_id = $1 ORDER BY created_at, id`,
  [r.company])).rows as Array<{ claim: boolean; pdf_sha256: string; plaintext_sha256: string | null; status: string }>;

beforeAll(async () => {
  a = await rig('w7-px-aes-a');
  b = await rig('w7-px-aes-b');
  await a.setup();
  await b.setup();
  await a.pool.query("DELETE FROM rate_limit_counters WHERE key LIKE 'send:payslips:%'");
  employee = await person(a, 250000, { email: 'aes@example.invalid', idNumber: ID });
  await person(b, 30000, { email: 'aes-b@example.invalid', idNumber: '7503035009085' });
  for (const r of [a, b]) {
    await enablePlatform(r);
    expect((await putSetting(r, true)).statusCode).toBe(200);
  }
  run = await approvedRun(a, 9);
}, 120_000);
afterAll(async () => {
  for (const r of [a, b]) await cleanup(r);
  expect(captured.every((m) => [m.to].flat().every((to) => String(to).endsWith('@example.invalid')))).toBe(true);
});

describe('W15: AES-256 payslip email', () => {
  it('a server that cannot encrypt refuses the whole request: 503, nothing sent, no row, no audit', async () => {
    const path = process.env.PATH;
    process.env.PATH = '/nonexistent-px';
    try {
      const res = await send(a, run);
      expect([res.statusCode, reason(res)]).toEqual([503, 'ENCRYPTION_UNAVAILABLE']);
    } finally {
      process.env.PATH = path;
    }
    expect(captured).toEqual([]);
    expect(await rows(a)).toEqual([]);
    expect(await audits(a, 'payslip_email')).toBe(0);
  });

  it('sends an AES-256 PDF that opens with the ID only, and records both hashes on the claim and the outcome', async () => {
    const res = await send(a, run);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(captured).toHaveLength(1);
    const pdf = captured[0]!.attachments![0]!.content as Buffer;
    const bytes = pdf.toString('latin1');
    expect(bytes).toMatch(/\/V 5\b/);
    expect(bytes).toMatch(/\/R 6\b/);
    expect(bytes).toMatch(/\/AESV3\b/);
    await expect(opens(pdf)).rejects.toThrow(/password/i);
    await expect(opens(pdf, '8001015009088')).rejects.toThrow(/password/i);
    expect(await opens(pdf, ID)).toContain('Payslip');
    const written = await rows(a);
    expect(written.map((w) => [w.claim, w.status])).toEqual([[true, 'unknown'], [false, 'sent']]);
    for (const w of written) {
      expect(w.pdf_sha256).toBe(sha(pdf));
      expect(w.plaintext_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(w.plaintext_sha256).not.toBe(w.pdf_sha256);
    }
    expect(res.body.data!.sent).toMatchObject([{ employeeId: employee, sha256: sha(pdf) }]);
  });

  it('a resend is a new encryption of the same render: new pdf_sha256, same plaintext_sha256', async () => {
    const res = await send(a, run, { body: { employeeIds: [employee], resend: true } });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const [first, second] = [captured[0]!, captured[1]!].map((m) => m.attachments![0]!.content as Buffer);
    expect(Buffer.compare(first!, second!)).not.toBe(0);
    const written = await rows(a);
    expect(written).toHaveLength(4);
    expect(written[3]!.pdf_sha256).toBe(sha(second!));
    expect(written[3]!.pdf_sha256).not.toBe(written[1]!.pdf_sha256);
    expect(new Set(written.map((w) => w.plaintext_sha256)).size).toBe(1);
  });

  it('the CHECK refuses a malformed plaintext_sha256 written as app_user', async () => {
    // run_approved_at read in SQL: a JS Date would drop the microseconds and the 999o guard would refuse first.
    await expect(asAppUser(a, a.admin, (q) => q(
      `INSERT INTO payslip_deliveries (company_id, run_id, employee_id, run_approved_at, recipient_email, pdf_sha256, plaintext_sha256, status, error)
       SELECT $1, h.id, $3, COALESCE(h.approved_at, h.approval_grandfathered_at), 'aes@example.invalid', repeat('a', 64), 'NOT-HEX', 'failed', 'x'
         FROM payroll_run_headers h WHERE h.id = $2`, [a.company, run, employee]),
    )).rejects.toThrow(/payslip_deliveries_plaintext_sha256_check/);
  });

  it('tenant b sees none of a\'s rows', async () => {
    expect(await rows(b)).toEqual([]);
  });
});

describe('W16: component types frozen at approval', () => {
  it('the snapshot holds each line\'s component types; a later re-type does not move a final slip\'s item', async () => {
    const snap = (await a.pool.query(
      `SELECT l.payslip_snapshot->'componentTypes' AS types FROM payroll_run_lines l WHERE l.run_id = $1 AND l.employee_id = $2`,
      [run, employee])).rows[0]!.types as Record<string, string>;
    const salary = (await a.pool.query(`SELECT id FROM payroll_components WHERE company_id = $1 AND name = 'Basic Salary'`, [a.company])).rows[0]!.id as string;
    expect(snap[salary]).toBe('earning');
    // Re-typed live after approval (as a later catalogue edit would): the final slip still itemises it as an earning.
    await a.pool.query(`UPDATE payroll_components SET component_type = 'deduction' WHERE id = $1`, [salary]);
    try {
      const res = await send(a, run, { body: { employeeIds: [employee], resend: true } });
      expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
      const text = await opens(captured.at(-1)!.attachments![0]!.content as Buffer, ID);
      const earnings = text.slice(text.indexOf('Earnings'), text.indexOf('Deductions'));
      expect(earnings).toContain('Basic Salary');
      expect(text).not.toContain('Not itemised');
    } finally {
      await a.pool.query(`UPDATE payroll_components SET component_type = 'earning' WHERE id = $1`, [salary]);
    }
  });
});
