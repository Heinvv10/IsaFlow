/**
 * Wave 6 PE, review #1542 round 1, through the real route (withAuth, app_user, RLS) and a capture mailer:
 *  - A2 / S2: a send the mail server may have taken (deadline: success false, provablyNotSent false) is recorded
 *    'unknown' and named; a plain re-POST does not mail it again; only an owner/admin resend names and resends it;
 *  - S3: a request that rolls back AFTER its sends keeps their delivery rows (each committed on its own), so the next
 *    POST sends nothing again;
 *  - A1: at most `limits.maxSends` per request; the rest is `remaining`, and the next request sends it;
 *  - D-I1: with a mail server refusing everything, a whole-run send moves on past the refused slips (they are skipped
 *    as LAST_SEND_FAILED, not retried ahead of the rest), so every slip is tried once and `remaining` reaches 0;
 *  - A5: GET lists each employee's latest delivery at this approval;
 *  - S4: the table stamps sent_by from the session, refuses a caller-named sent_by, a write with no session user and
 *    a recipient other than the address on file;
 *  - A1 of the repros (a manager pointing a first address at themselves) is in pe-payslip-email-settings.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rig } from './brkr.helpers';
import {
  approvedRun, asAppUser, captured, cleanup, deliveries, enablePlatform, failNext, listDeliveries, maybeNext, person, putSetting,
  reason, send, sendVariant, type R,
} from './pe-payslip-email.helpers';

let a: R;
const emp = { one: '', two: '', three: '' };
const ids = (xs: Array<{ employeeId: string }>) => xs.map((x) => x.employeeId).sort();

beforeAll(async () => {
  a = await rig('payslip-email-round1');
  await a.setup();
  await a.pool.query("DELETE FROM rate_limit_counters WHERE key LIKE 'send:payslips:%'");
  emp.one = await person(a, 25000, { email: 'one@example.invalid', idNumber: '8001015009087' });
  emp.two = await person(a, 24000, { email: 'two@example.invalid', idNumber: '8001015009087' });
  emp.three = await person(a, 23000, { email: 'three@example.invalid', passport: 'P333' });
  await enablePlatform(a);
  expect((await putSetting(a, true)).statusCode).toBe(200);
}, 120_000);
// Each test starts with empty send-limit buckets (per IP and per company), so the suites can share one process.
beforeEach(async () => {
  await a.pool.query("DELETE FROM rate_limit_counters WHERE key LIKE 'send:payslips:%'");
});
afterAll(async () => {
  await cleanup(a);
  expect(captured.every((m) => [m.to].flat().every((to) => String(to).endsWith('@example.invalid')))).toBe(true);
});

describe('payslip email, review round 1', () => {
  it('A2/S2: a send that may have reached the server is "unknown" and is not mailed again by a plain POST', async () => {
    const run = await approvedRun(a, 5);
    maybeNext.count = 1;
    const first = await send(a, run, { body: { employeeIds: [emp.one] } });
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    expect(ids(first.body.data!.uncertain)).toEqual([emp.one]);
    expect(first.body.data!.failed).toEqual([]);
    expect((await deliveries(a)).map((d) => [d.employee_id, d.status])).toEqual([[emp.one, 'unknown']]);
    const before = captured.length;
    const again = await send(a, run, { body: { employeeIds: [emp.one] } });
    expect(again.body.data!.skipped.map((s: { reason: string }) => s.reason)).toEqual(['ALREADY_SENT']);
    expect(captured.length).toBe(before);
    // A resend is a person's choice: owner/admin only, and it names whom.
    const manager = await a.addUser('manager');
    expect((await send(a, run, { user: manager, body: { employeeIds: [emp.one], resend: true } })).statusCode).toBe(403);
    expect((await send(a, run, { body: { resend: true } })).statusCode).toBe(400);
    const resend = await send(a, run, { body: { employeeIds: [emp.one], resend: true } });
    expect(ids(resend.body.data!.sent)).toEqual([emp.one]);
    expect(captured.length).toBe(before + 1);
  });

  it('S3: a request that rolls back after its sends keeps their rows, so nothing is mailed twice', async () => {
    const run = await approvedRun(a, 6);
    const before = captured.length;
    const failed = await sendVariant(a, run, { failAfter: true });
    expect(failed.statusCode).toBe(500);
    expect(captured.length).toBe(before + 3);
    const rows = (await deliveries(a)).filter((d) => d.run_id === run);
    expect(rows.map((d) => [d.status, d.sent_by]).sort()).toEqual([['sent', a.admin], ['sent', a.admin], ['sent', a.admin]]);
    const audited = Number((await a.pool.query(
      "SELECT count(*) FROM audit_log WHERE company_id = $1 AND entity_type = 'payslip_email' AND entity_id = $2", [a.company, run])).rows[0]!.count);
    expect(audited).toBe(3);
    const again = await send(a, run);
    expect(again.body.data!.sent).toEqual([]);
    expect(captured.length).toBe(before + 3);
  });

  it('A1: at most maxSends per request; the rest is "remaining" and the next request sends it; GET lists them', async () => {
    const run = await approvedRun(a, 7);
    const first = await sendVariant(a, run, { limits: { maxSends: 2, budgetMs: 60_000 } });
    expect([first.body.data!.sent.length, first.body.data!.remaining]).toEqual([2, 1]);
    const second = await sendVariant(a, run, { limits: { maxSends: 2, budgetMs: 60_000 } });
    expect([second.body.data!.sent.length, second.body.data!.remaining]).toEqual([1, 0]);
    // No time left after the first send: the rest waits for the next request.
    const run2 = await approvedRun(a, 8);
    const timed = await sendVariant(a, run2, { limits: { maxSends: 20, budgetMs: -1 } });
    expect([timed.body.data!.sent.length, timed.body.data!.remaining]).toEqual([1, 2]);

    const list = await listDeliveries(a, run);
    expect(list.statusCode).toBe(200);
    expect(list.body.data!.map((d: { employeeId: string; status: string; recipient: string; attempts: number }) =>
      [d.employeeId, d.status, d.recipient, d.attempts]).sort()).toEqual([
      [emp.one, 'sent', 'one@example.invalid', 1], [emp.three, 'sent', 'three@example.invalid', 1],
      [emp.two, 'sent', 'two@example.invalid', 1]].sort());
    expect((await listDeliveries(a, run, { user: await a.addUser('viewer') })).statusCode).toBe(403);
  });

  it('D-I1: refused slips are not re-queued ahead of the rest; every slip is tried once, then nothing remains', async () => {
    const run = await approvedRun(a, 10);
    const limits = { maxSends: 2, budgetMs: 60_000 };
    failNext.count = 99;
    try {
      const r1 = (await sendVariant(a, run, { limits })).body.data!;
      expect([r1.failed.length, r1.remaining]).toEqual([2, 1]);
      const r2 = (await sendVariant(a, run, { limits })).body.data!;
      expect([r2.failed.length, r2.remaining]).toEqual([1, 0]);
      expect(ids([...r1.failed, ...r2.failed])).toEqual([emp.one, emp.two, emp.three].sort());
      expect(r2.skipped.map((s: { reason: string }) => s.reason)).toEqual(['LAST_SEND_FAILED', 'LAST_SEND_FAILED']);
      const r3 = (await sendVariant(a, run, { limits })).body.data!;
      expect([r3.failed.length, r3.sent.length, r3.remaining]).toEqual([0, 0, 0]);
    } finally {
      failNext.count = 0;
    }
    // Naming the employee is the retry.
    const retry = await send(a, run, { body: { employeeIds: [emp.three] } });
    expect(ids(retry.body.data!.sent)).toEqual([emp.three]);
  });

  it('S4: the table stamps sent_by from the session and refuses what the code never writes', async () => {
    const run = await approvedRun(a, 9);
    // VALUES, not a SELECT from the header: with no session, RLS would hide the header and insert nothing at all.
    const approvedAt = String((await a.pool.query('SELECT approved_at::text AS t FROM payroll_run_headers WHERE id = $1', [run])).rows[0]!.t);
    const row = [a.company, run, emp.one, approvedAt];
    const insert = (cols: string, vals: string, _values: unknown[]) => `INSERT INTO payslip_deliveries
      (company_id, run_id, employee_id, run_approved_at, pdf_sha256, status${cols})
      VALUES ($1, $2, $3, $4::timestamptz, repeat('a', 64), 'sent'${vals}) RETURNING sent_by`;
    const stamped = await asAppUser(a, a.admin, (q) => q(insert(', recipient_email', ", 'one@example.invalid'", row), row));
    expect(stamped.rows).toEqual([{ sent_by: a.admin }]);
    await expect(asAppUser(a, a.admin, (q) => q(insert(', recipient_email, sent_by', ", 'one@example.invalid', 'forger'", row), row)))
      .rejects.toThrow(/permission denied/);
    await expect(asAppUser(a, null, (q) => q(insert(', recipient_email', ", 'one@example.invalid'", row), row)))
      .rejects.toThrow(/needs a session user/);
    await expect(asAppUser(a, a.admin, (q) => q(insert(', recipient_email', ", 'elsewhere@example.invalid'", row), row)))
      .rejects.toThrow(/another address/);
    expect(reason(await send(a, run, { body: { employeeIds: [emp.one] } }))).toBeUndefined();
  });
});
