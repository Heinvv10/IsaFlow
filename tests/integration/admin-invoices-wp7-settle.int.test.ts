/**
 * WP7 review round 2 of #1368: a claimed invoice (a Send whose outcome is unknown, migration 991) is visible and
 * can be settled, a claim is released when the Send failed before anything reached the mail server, and a
 * billing email changed after the confirm dialog is refused. Real routes, disposable schema fixture, nodemailer
 * mocked (nothing leaves this process), recipients on the reserved .test TLD.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mail = vi.hoisted(() => {
  const sendMail = vi.fn(async (_opts: Record<string, unknown>) => ({ messageId: 'wp7-settle-mock' }));
  const createTransport = vi.fn((_cfg: Record<string, unknown>) => ({ sendMail }));
  return { sendMail, createTransport, failBuild: { next: false } };
});
vi.mock('nodemailer', () => ({ default: { createTransport: mail.createTransport }, createTransport: mail.createTransport }));
vi.mock('@/modules/admin/services/adminInvoiceEmail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/admin/services/adminInvoiceEmail')>();
  return {
    ...actual,
    adminInvoiceEmail: (data: Parameters<typeof actual.adminInvoiceEmail>[0]) => {
      if (mail.failBuild.next) { mail.failBuild.next = false; throw new Error('wp7 test: template failed'); }
      return actual.adminInvoiceEmail(data);
    },
  };
});

import invoicesRoute from '../../pages/api/admin/billing/invoices';
import sendRoute from '../../pages/api/admin/billing/invoices/[id]/send';
import settleRoute from '../../pages/api/admin/billing/invoices/[id]/settle-send';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { invoiceSendFixture } from './helpers/adminInvoiceSendFixture';

assertDisposable();
const fx = invoiceSendFixture('settle');
const send = (id: string, to = fx.billing) => fx.call(sendRoute as never, { confirmed_to: to }, id);
const settle = (id: string, outcome: string) => fx.call(settleRoute as never, { outcome }, id);
/**
 * A draft whose Send timed out: the claim stays (outcome unknown). `old` backdates the claim past
 * SEND_SETTLE_AFTER_MS (2 min), the age a claim must reach before it may be settled.
 */
async function stranded(old = true): Promise<string> {
  const id = await fx.draft();
  mail.sendMail.mockRejectedValueOnce(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }));
  fx.expectStatus(await send(id), 424);
  expect((await fx.row(id)).send_claimed_at).not.toBeNull();
  if (old) await fx.pool.query("UPDATE admin_invoices SET send_claimed_at = NOW() - interval '3 minutes' WHERE id=$1", [id]);
  return id;
}
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}
async function until(check: () => boolean, ms = 10000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  vi.stubEnv('SMTP_HOST', 'smtp.wp7-mock.invalid');
  vi.stubEnv('SMTP_USER', 'wp7-mock');
  vi.stubEnv('SMTP_PASS', 'wp7-mock');
  await fx.setup();
}, 60000);
beforeEach(() => { mail.sendMail.mockClear(); mail.failBuild.next = false; });
afterAll(async () => { vi.unstubAllEnvs(); await fx.teardown(); }, 60000);

describe('WP7 claim visibility and release', () => {
  it('a throw before sendEmail runs releases the claim: still a draft, no email, a retry sends', async () => {
    const id = await fx.draft();
    mail.failBuild.next = true;
    const r = await send(id);
    fx.expectStatus(r, 500);
    expect(r.body.error?.message).toMatch(/could not be prepared; it is still a draft/);
    expect(mail.sendMail).not.toHaveBeenCalled();
    const after = await fx.row(id);
    expect([after.status, after.send_claimed_at]).toEqual(['draft', null]);
    expect(await fx.audits(id, 'invoice.send_failed')).toBe(1);
    fx.expectStatus(await send(id), 200);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  }, 60000);

  it('the list shows a claimed invoice with the time its send started', async () => {
    const id = await stranded();
    const list = await fx.call(invoicesRoute as never, undefined, undefined, { company_id: fx.company, limit: '100' });
    fx.expectStatus(list, 200);
    const item = (list.body.data?.items as Array<{ id: string; send_claimed_at: string | null; billing_email: string | null }>)
      .find((i) => i.id === id);
    expect(item?.send_claimed_at).toBeTruthy();
    expect(item?.billing_email).toBe(fx.billing);
  }, 60000);

  it('a billing email changed after the confirm dialog is refused: no claim, no email', async () => {
    const id = await fx.draft();
    const r = await send(id, `someone-else@wp7.example.test`);
    fx.expectStatus(r, 409);
    expect(r.body.error?.message).toMatch(/billing email changed/i);
    expect((await fx.row(id)).send_claimed_at).toBeNull();
    expect(mail.sendMail).not.toHaveBeenCalled();
    fx.expectStatus(await send(id, fx.billing.toUpperCase()), 200); // the same address, other case: the same mailbox
  }, 60000);
});

describe('WP7 settle a send whose outcome is unknown', () => {
  it("'sent': status sent, claim cleared, audited; nothing is emailed", async () => {
    const id = await stranded();
    mail.sendMail.mockClear();
    const r = await settle(id, 'sent');
    fx.expectStatus(r, 200);
    const after = await fx.row(id);
    expect([after.status, after.send_claimed_at]).toEqual(['sent', null]);
    expect(await fx.auditDetails(id, 'invoice.send_settled')).toEqual([expect.objectContaining({ outcome: 'sent' })]);
    expect(mail.sendMail).not.toHaveBeenCalled();
  }, 60000);

  it("'released': still a draft, claim cleared, audited; it can be sent again", async () => {
    const id = await stranded();
    fx.expectStatus(await settle(id, 'released'), 200);
    const after = await fx.row(id);
    expect([after.status, after.send_claimed_at]).toEqual(['draft', null]);
    expect(await fx.auditDetails(id, 'invoice.send_settled')).toEqual([expect.objectContaining({ outcome: 'released' })]);
    fx.expectStatus(await send(id), 200);
  }, 60000);

  it('an unclaimed invoice answers 409, a missing one 404, a bad outcome 400; none writes an audit row', async () => {
    const id = await fx.draft();
    fx.expectStatus(await settle(id, 'sent'), 409);
    fx.expectStatus(await settle(id, 'released'), 409);
    expect((await fx.row(id)).status).toBe('draft');
    fx.expectStatus(await settle(crypto.randomUUID(), 'released'), 404);
    fx.expectStatus(await settle(id, 'maybe'), 400);
    expect(await fx.audits(id, 'invoice.send_settled')).toBe(0);
  }, 60000);

  it('a claim younger than 2 minutes is refused either way: still in progress, nothing changes', async () => {
    const id = await stranded(false);
    const before = await fx.row(id);
    for (const outcome of ['sent', 'released']) {
      const r = await settle(id, outcome);
      fx.expectStatus(r, 409);
      expect(r.body.error?.message).toMatch(/still in progress; try again shortly/);
    }
    const after = await fx.row(id);
    expect([after.status, String(after.send_claimed_at)]).toEqual(['draft', String(before.send_claimed_at)]);
    expect(await fx.audits(id, 'invoice.send_settled')).toBe(0);
  }, 60000);

  it('two concurrent Settles: exactly one wins, the other is a 409, one audit row', async () => {
    const id = await stranded();
    const results = await Promise.all([settle(id, 'sent'), settle(id, 'released')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results[0]!.status === 200 ? 'sent' : 'released';
    const after = await fx.row(id);
    expect([after.status, after.send_claimed_at]).toEqual([winner === 'sent' ? 'sent' : 'draft', null]);
    expect(await fx.auditDetails(id, 'invoice.send_settled')).toEqual([expect.objectContaining({ outcome: winner })]);
  }, 60000);

  it('a Settle racing a Send still talking to the mail server is refused; the Send completes once', async () => {
    const id = await fx.draft();
    const smtp = gate();
    mail.sendMail.mockImplementationOnce(async () => { await smtp.promise; return { messageId: 'in-flight' }; });
    const inFlight = send(id);
    try {
      await until(() => mail.sendMail.mock.calls.length === 1);
      for (const outcome of ['released', 'sent']) {
        const r = await settle(id, outcome);
        fx.expectStatus(r, 409);
        expect(r.body.error?.message).toMatch(/still in progress/);
      }
    } finally {
      smtp.open();
    }
    fx.expectStatus(await inFlight, 200);
    const after = await fx.row(id);
    expect([after.status, after.send_claimed_at]).toEqual(['sent', null]);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(await fx.audits(id, 'invoice.send_settled')).toBe(0);
  }, 60000);
});
