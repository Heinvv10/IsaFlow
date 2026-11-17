/**
 * Wave 6 PE, review #1542 delta round, through the real route and a capture mailer (B1/B2 from the reviewer's
 * rev1542-sec-r2 repros, turned into regressions):
 *  - B1 / D-S1: the claim ("may have been sent") commits BEFORE the mail leaves. A held employee row is refused
 *    before anything is sent; when the outcome cannot be written after the send, the answer is 200 with the slip
 *    `uncertain` (never a retryable 503), and a plain re-POST does not mail it again;
 *  - B2 / D-A2 / D-S2: the slips' employee rows are share-locked for the request, so an address change during the
 *    send waits (here: refused at its own lock timeout), the record names the address the mail went to, and the next
 *    plain send says ALREADY_SENT;
 *  - D-A1: a server refusing everything, 21 slips, the default batch of 20: the 21st is tried in the second request,
 *    and the third has nothing left;
 *  - E-A1: only the batch's employee rows are locked: another employee of the run can be edited mid-send;
 *  - E-I1: the claim row exists while the mail is being handed over;
 *  - B3: the deliveries GET is tenant-scoped;
 *  - D-S4: a slip once delivered stays ALREADY_SENT after a later failed resend: a manager naming the employee
 *    does not mail it again.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmailOptions } from '@/modules/accounting/services/core/emailService';
import { rig } from './brkr.helpers';
import {
  approvedRun, captured, cleanup, deliveries, enablePlatform, failNext, listDeliveries, person, putSetting, send, sendVariant, setDuring, type R,
} from './pe-payslip-email.helpers';

let a: R;
let b: R;
const ID = '8001015009087';

beforeAll(async () => {
  a = await rig('payslip-email-round2-a');
  b = await rig('payslip-email-round2-b');
  for (const r of [a, b]) {
    await r.setup();
    await enablePlatform(r);
    expect((await putSetting(r, true)).statusCode).toBe(200);
  }
  await a.pool.query("DELETE FROM rate_limit_counters WHERE key LIKE 'send:payslips:%'");
}, 120_000);
afterAll(async () => {
  setDuring(null);
  for (const r of [a, b]) await cleanup(r);
  expect(captured.every((m) => [m.to].flat().every((to) => String(to).endsWith('@example.invalid')))).toBe(true);
});

const sentTo = (to: string) => captured.filter((m: EmailOptions) => m.to === to).length;

describe('payslip email, review delta round', () => {
  it('B1: a held employee row is refused before anything is sent; nothing is lost or doubled', async () => {
    const victim = await person(a, 22000, { email: 'b1@example.invalid', idNumber: ID });
    const run = await approvedRun(a, 6);
    const holder = await a.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM payroll_employees WHERE id = $1 FOR UPDATE', [victim]);
      const refused = await send(a, run, { body: { employeeIds: [victim] } });
      expect(refused.statusCode).toBe(503);
      expect(sentTo('b1@example.invalid')).toBe(0);
      expect(await deliveries(a, { claims: true })).toEqual([]);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await send(a, run, { body: { employeeIds: [victim] } })).body.data!.sent.length).toBe(1);
    expect(sentTo('b1@example.invalid')).toBe(1);
  }, 30_000);

  it('B1/D-S1: the outcome cannot be written after the send: 200, "may have been sent", and no second mail', async () => {
    const victim = await person(a, 21000, { email: 'b1-out@example.invalid', idNumber: ID });
    const run = await approvedRun(a, 7);
    const url = process.env.DATABASE_URL;
    // During the send, point new connections (the outcome's own transaction) at nothing.
    let claimedDuringSend: unknown[] = [];
    setDuring(async () => {
      // E-I1: the claim is already committed while the mail is being handed over.
      claimedDuringSend = (await a.pool.query(
        'SELECT status FROM payslip_deliveries WHERE company_id = $1 AND run_id = $2 AND employee_id = $3 AND claim', [a.company, run, victim])).rows;
      process.env.DATABASE_URL = 'postgresql://postgres@127.0.0.1:1/none?sslmode=disable';
    });
    let first;
    try {
      first = await send(a, run, { body: { employeeIds: [victim] } });
    } finally {
      setDuring(null);
      process.env.DATABASE_URL = url;
    }
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    expect(claimedDuringSend).toEqual([{ status: 'unknown' }]);
    expect(first.body.data!.uncertain.map((u: { employeeId: string }) => u.employeeId)).toEqual([victim]);
    expect(sentTo('b1-out@example.invalid')).toBe(1);
    const claims = (await deliveries(a, { claims: true })).filter((d) => d.employee_id === victim);
    expect(claims.map((d) => d.status)).toEqual(['unknown']);
    expect((await deliveries(a)).filter((d) => d.employee_id === victim)).toEqual([]);
    const again = await send(a, run, { body: { employeeIds: [victim] } });
    expect(again.body.data!.skipped.map((s: { reason: string }) => s.reason)).toEqual(['ALREADY_SENT']);
    expect(sentTo('b1-out@example.invalid')).toBe(1);
  }, 30_000);

  it('B2: an address change during the send waits; the record names where the mail went', async () => {
    const victim = await person(a, 20000, { email: 'b2-old@example.invalid', idNumber: ID });
    const run = await approvedRun(a, 8);
    let change = '';
    setDuring(async () => {
      const c = await a.pool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SET LOCAL lock_timeout = '1s'");
        await c.query("UPDATE payroll_employees SET email = 'b2-new@example.invalid' WHERE id = $1", [victim]);
        change = 'committed';
        await c.query('COMMIT');
      } catch (err) {
        change = err instanceof Error ? err.message : String(err);
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    });
    let first;
    try {
      first = await send(a, run, { body: { employeeIds: [victim] } });
    } finally {
      setDuring(null);
    }
    expect(change).toMatch(/lock timeout/);
    expect(first.body.data!.sent.map((s: { employeeId: string }) => s.employeeId)).toEqual([victim]);
    expect((await deliveries(a)).filter((d) => d.employee_id === victim).map((d) => [d.status, d.recipient_email]))
      .toEqual([['sent', 'b2-old@example.invalid']]);
    // Now the change goes through; the slip of this approval is not mailed again to the new address.
    await a.pool.query("UPDATE payroll_employees SET email = 'b2-new@example.invalid' WHERE id = $1", [victim]);
    const again = await send(a, run, { body: { employeeIds: [victim] } });
    expect(again.body.data!.skipped.map((s: { reason: string }) => s.reason)).toEqual(['ALREADY_SENT']);
    expect(sentTo('b2-new@example.invalid')).toBe(0);
  }, 30_000);

  it('D-S4: sent, then an owner resend fails: a manager naming the employee gets ALREADY_SENT, not a second mail', async () => {
    const victim = await person(a, 19000, { email: 'ds4@example.invalid', idNumber: ID });
    const run = await approvedRun(a, 10);
    expect((await send(a, run, { body: { employeeIds: [victim] } })).body.data!.sent.length).toBe(1);
    failNext.count = 1;
    const resend = await send(a, run, { body: { employeeIds: [victim], resend: true } });
    expect(resend.body.data!.failed.map((f: { employeeId: string }) => f.employeeId)).toEqual([victim]);
    const manager = await a.addUser('manager');
    const plain = await send(a, run, { user: manager, body: { employeeIds: [victim] } });
    expect(plain.statusCode, JSON.stringify(plain.body)).toBe(200);
    expect(plain.body.data!.skipped.map((s: { reason: string }) => s.reason)).toEqual(['ALREADY_SENT']);
    expect(sentTo('ds4@example.invalid')).toBe(1);
  });

  it('E-A1: only the batch is locked: another employee of the run can be edited during a send', async () => {
    const run = await approvedRun(a, 11);
    const all = (await a.pool.query(
      'SELECT l.employee_id, e.email FROM payroll_run_lines l JOIN payroll_employees e ON e.id = l.employee_id WHERE l.run_id = $1', [run])).rows;
    let edited = '';
    setDuring(async (o) => {
      const other = all.find((x) => x.email !== o.to)!;
      const c = await a.pool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SET LOCAL lock_timeout = '1s'");
        await c.query("UPDATE payroll_employees SET occupation = 'Edited mid-send' WHERE id = $1", [other.employee_id]);
        await c.query('ROLLBACK');
        edited = 'not blocked';
      } catch (err) {
        edited = err instanceof Error ? err.message : String(err);
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    });
    try {
      const res = await sendVariant(a, run, { limits: { maxSends: 1, budgetMs: 60_000 } });
      expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    } finally {
      setDuring(null);
    }
    expect(edited).toBe('not blocked');
  }, 30_000);

  it('B3: the deliveries GET is tenant-scoped', async () => {
    const run = (await a.pool.query('SELECT DISTINCT run_id FROM payslip_deliveries WHERE company_id = $1 LIMIT 1', [a.company])).rows[0]!.run_id;
    const foreign = await listDeliveries(b, String(run));
    expect([foreign.statusCode, foreign.body.data]).toEqual([200, []]);
  });

  it('D-A1: a server refusing all of 21 slips: the 21st is tried in the second request; the third has nothing left', async () => {
    for (let i = 0; i < 21; i += 1) await person(b, 10000 + i, { email: `d-a1-${i}@example.invalid`, idNumber: ID });
    const run = await approvedRun(b, 9);
    failNext.count = 999;
    try {
      const r1 = (await send(b, run)).body.data!;
      expect([r1.failed.length, r1.remaining]).toEqual([20, 1]);
      const r2 = (await send(b, run)).body.data!;
      expect([r2.failed.length, r2.remaining]).toEqual([1, 0]);
      const r3 = (await send(b, run)).body.data!;
      expect([r3.failed.length, r3.sent.length, r3.remaining]).toEqual([0, 0, 0]);
      expect(new Set([...r1.failed, ...r2.failed].map((f: { employeeId: string }) => f.employeeId)).size).toBe(21);
    } finally {
      failNext.count = 0;
    }
  }, 120_000);
});
