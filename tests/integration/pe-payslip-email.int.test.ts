/**
 * Wave 6 PE: emailing a final run's payslips, through the real send route (withAuth, app_user, RLS) built with a
 * CAPTURE mailer, on two tenants. Nothing here can send: see pe-payslip-email.helpers.ts.
 * Claims:
 *  - every refusal (platform switch off, even with the company setting on; setting off; not final; Login-as; an
 *    agent token; a viewer; another tenant's run; details not frozen) sends nothing and writes no row;
 *  - a send attaches one password-protected PDF per employee, records pdf_sha256 = the hash of the exact bytes sent,
 *    skips and names an employee with no address or no ID/passport number, and audits once;
 *  - it is idempotent per (run, employee, approval): again = ALREADY_SENT; resend = the same bytes; a failed send is
 *    retried; a re-approval may be sent again;
 *  - every captured recipient is @example.invalid; the table refuses a row the code would never write.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { createHash } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig } from './brkr.helpers';
import {
  agent, approvedRun, audits, capture, captured, cleanup, deliveries, enablePlatform, failNext, loginAs, person, putSetting,
  reapprove, reason, send, type R,
} from './pe-payslip-email.helpers';

let a: R;
let b: R;
const emp = { idOnly: '', noEmail: '', noId: '', passport: '' };
let run = '';
let bRun = '';
const ID = '8001015009087';

async function opens(pdf: Buffer, password?: string): Promise<string> {
  const { PDFParse } = (await import('pdf-parse')) as unknown as {
    PDFParse: new (o: { data: Buffer; password?: string }) => { getText(): Promise<{ text: string }> };
  };
  return (await new PDFParse({ data: Buffer.from(pdf), ...(password ? { password } : {}) }).getText()).text;
}
const attachment = (i: number) => captured[i]!.attachments![0]!.content;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  a = await rig('payslip-email-a');
  b = await rig('payslip-email-b');
  await a.setup();
  await b.setup();
  // The send limit's buckets (per IP, per company) outlive a run on a reused disposable database: start empty.
  await a.pool.query("DELETE FROM rate_limit_counters WHERE key LIKE 'send:payslips:%'");
  emp.idOnly = await person(a, 25000, { email: 'thandi@example.invalid', idNumber: ID });
  emp.noEmail = await person(a, 18000, { email: null, idNumber: '9002025009081' });
  emp.noId = await person(a, 17000, { email: 'no-id@example.invalid' });
  emp.passport = await person(a, 16000, { email: 'pass@example.invalid', passport: 'M1234567' });
  await person(b, 30000, { email: 'other-tenant@example.invalid', idNumber: '7503035009085' });
}, 120_000);
afterAll(async () => {
  for (const r of [a, b]) await cleanup(r);
  expect(captured.every((m) => [m.to].flat().every((to) => String(to).endsWith('@example.invalid')))).toBe(true);
});

describe('payslip email', () => {
  it('refuses before anything is sent or written', async () => {
    run = await a.calculatedRun(1);
    // The company setting on does not open the platform switch (F7: a client admin cannot make the first send).
    expect((await putSetting(a, true)).statusCode).toBe(200);
    const off = await send(a, run);
    expect([off.statusCode, reason(off)]).toEqual([403, 'FEATURE_DISABLED']);
    await enablePlatform(a);
    expect((await putSetting(a, false)).statusCode).toBe(200);
    const settingOff = await send(a, run);
    expect([settingOff.statusCode, reason(settingOff)]).toEqual([409, 'SETTING_OFF']);
    expect((await putSetting(a, true)).statusCode).toBe(200);
    const notFinal = await send(a, run);
    expect([notFinal.statusCode, reason(notFinal)]).toEqual([409, 'NOT_FINAL']);
    expect((await a.api.approve(run)).statusCode).toBe(200);

    const imp = await send(a, run, { user: await loginAs(a, a.admin) });
    expect([imp.statusCode, imp.body.error?.details?.reason ?? imp.body.error?.code]).toEqual([403, 'IMPERSONATION_FORBIDDEN']);
    const bot = await send(a, run, { user: await agent(a, a.admin) });
    expect([bot.statusCode, reason(bot)]).toEqual([403, 'AGENT_FORBIDDEN']);
    expect((await send(a, run, { user: await a.addUser('viewer') })).statusCode).toBe(403);
    // Another tenant's run, asked for as that tenant's own admin: not found (b's platform switch is on too).
    await enablePlatform(b);
    expect((await putSetting(b, true)).statusCode).toBe(200);
    const foreign = await send(b, run);
    expect([foreign.statusCode, reason(foreign)]).toEqual([404, 'NOT_FOUND']);
    const bad = await send(a, run, { body: { resend: 'yes' } });
    expect(bad.statusCode).toBe(400);

    expect(captured).toEqual([]);
    expect(await deliveries(a)).toEqual([]);
    expect(await deliveries(b)).toEqual([]);
    expect(await audits(a, 'payslip_email')).toBe(0);
  });

  it('sends one protected PDF per employee, skips and names the rest, records the hash of the bytes sent', async () => {
    const res = await send(a, run);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const out = res.body.data!;
    expect(out.sent.map((s: { employeeId: string }) => s.employeeId).sort()).toEqual([emp.idOnly, emp.passport].sort());
    expect(out.skipped.map((s: { employeeId: string; reason: string }) => [s.employeeId, s.reason]).sort()).toEqual([
      [emp.noEmail, 'NO_EMAIL'], [emp.noId, 'NO_ID_OR_PASSPORT']].sort());
    expect(out.skipped.every((s: { employeeNumber: string }) => /^BRK-\d+$/.test(s.employeeNumber))).toBe(true);
    expect(out.failed).toEqual([]);

    expect(captured.map((m) => m.to).sort()).toEqual(['pass@example.invalid', 'thandi@example.invalid']);
    const rows = await deliveries(a);
    expect(rows.map((d) => [d.recipient_email, d.status, d.resend, d.sent_by, d.current])).toEqual(
      captured.map((m) => [m.to, 'sent', false, a.admin, true]));
    captured.forEach((m, i) => {
      expect(rows[i]!.pdf_sha256).toBe(sha(attachment(i)));
      expect(rows[i]!.message_id).toBe(`<pe-${i + 1}@example.invalid>`);
      expect(JSON.stringify(m)).not.toContain(ID);
    });
    const thandi = captured.findIndex((m) => m.to === 'thandi@example.invalid');
    await expect(opens(attachment(thandi))).rejects.toThrow(/password/i);
    expect(await opens(attachment(thandi), ID)).toContain('Brk BRK-1');
    expect(await opens(attachment(1 - thandi), 'M1234567')).toContain('Payslip');
    expect(await audits(a, 'payslip_email')).toBe(1);
  });

  it('is idempotent per approval; resend sends the same bytes; a failed send is retried', async () => {
    const again = await send(a, run);
    expect(again.body.data!.sent).toEqual([]);
    expect(again.body.data!.skipped.filter((s: { reason: string }) => s.reason === 'ALREADY_SENT').length).toBe(2);
    expect(captured.length).toBe(2);
    expect(await audits(a, 'payslip_email')).toBe(1); // nothing attempted, nothing audited

    const first = captured.find((m) => m.to === 'thandi@example.invalid')!.attachments![0]!.content;
    const resend = await send(a, run, { body: { employeeIds: [emp.idOnly], resend: true } });
    expect(resend.body.data!.sent.map((s: { employeeId: string }) => s.employeeId)).toEqual([emp.idOnly]);
    expect(Buffer.compare(attachment(2), first)).toBe(0);
    expect((await deliveries(a)).at(-1)).toMatchObject({ resend: true, pdf_sha256: sha(first) });

    failNext.count = 1;
    await a.pool.query("UPDATE payroll_employees SET email = 'retry@example.invalid' WHERE id = $1", [emp.noId]);
    await a.pool.query("UPDATE payroll_employees SET id_number = '9103035009089' WHERE id = $1", [emp.noId]);
    const failed = await send(a, run, { body: { employeeIds: [emp.noId] } });
    expect(failed.body.data!.failed.map((f: { employeeId: string }) => f.employeeId)).toEqual([emp.noId]);
    expect((await deliveries(a)).at(-1)).toMatchObject({ status: 'failed', error: '550 mailbox unavailable', message_id: null });
    const retried = await send(a, run, { body: { employeeIds: [emp.noId] } });
    expect(retried.body.data!.sent.map((s: { employeeId: string }) => s.employeeId)).toEqual([emp.noId]);
  });

  it('a re-approval is another document: it may be sent again, and the old rows stay with the old approval', async () => {
    await reapprove(a, run);
    const before = captured.length;
    const res = await send(a, run, { body: { employeeIds: [emp.idOnly] } });
    expect(res.body.data!.sent.length).toBe(1);
    expect(captured.length).toBe(before + 1);
    expect((await deliveries(a)).filter((d) => d.employee_id === emp.idOnly).map((d) => d.current)).toEqual([false, false, true]);
  });

  it('refuses a final run whose details were not frozen at this approval (approved before PS3)', async () => {
    const old = await approvedRun(a, 2);
    await a.pool.query('UPDATE payroll_run_lines SET payslip_snapshot = NULL WHERE run_id = $1', [old]);
    const rows = (await deliveries(a)).length;
    const res = await send(a, old);
    expect([res.statusCode, reason(res)]).toEqual([409, 'DETAILS_NOT_FROZEN']);
    expect((await deliveries(a)).length).toBe(rows);
  });

  it('tenants: b sends its own run only, sees none of a\'s rows; the table refuses a forged row', async () => {
    bRun = await approvedRun(b, 1);
    const res = await send(b, bRun);
    expect(res.body.data!.sent.length).toBe(1);
    expect((await deliveries(b)).map((d) => d.run_id)).toEqual([bRun]);
    expect((await deliveries(a)).some((d) => d.run_id === bRun)).toBe(false);
    // Company a's row naming b's run: the guard trigger refuses it (as the superuser; RLS would also hide the run).
    await expect(a.pool.query(
      `INSERT INTO payslip_deliveries (company_id, run_id, employee_id, run_approved_at, recipient_email, pdf_sha256, status, sent_by)
       SELECT $1, h.id, l.employee_id, h.approved_at, 'x@example.invalid', repeat('a', 64), 'sent', 'forger'
         FROM payroll_run_headers h JOIN payroll_run_lines l ON l.run_id = h.id WHERE h.id = $2 LIMIT 1`, [a.company, bRun],
    )).rejects.toThrow(/not a final run of this company/);
    expect(typeof capture).toBe('function');
  });
});
