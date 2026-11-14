/**
 * WP7 review round 2 of #1368, L4: the invoice Send writes its email_log row OUTSIDE every transaction, through
 * the bare `sql` pool, which production logs in as isaflow_service (migration 915: SERVICE_DATABASE_URL; it
 * inherits app_service). email_log is under FORCE RLS and logEmailAttempt swallows a failed INSERT (it only logs),
 * so a policy that refused that role would drop the record of a sent email without a sound. This suite logs the
 * bare pool in AS isaflow_service (a real LOGIN, so session_user is the role, as in production) and proves the
 * row lands: for logEmailAttempt on its own, and for a whole Send through the route.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mail = vi.hoisted(() => {
  const sendMail = vi.fn(async (_opts: Record<string, unknown>) => ({ messageId: 'wp7-rls-mock' }));
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});
vi.mock('nodemailer', () => ({ default: { createTransport: mail.createTransport }, createTransport: mail.createTransport }));

import sendRoute from '../../pages/api/admin/billing/invoices/[id]/send';
import { logEmailAttempt } from '@/modules/accounting/services/core/emailService';
import { getPool } from '@/lib/neon';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { invoiceSendFixture } from './helpers/adminInvoiceSendFixture';

assertDisposable();
const fx = invoiceSendFixture('rls');

beforeAll(async () => {
  // As the ops step does in production (docs/runbooks/s07b-app-pool-login-roles.md), then the app's env points at it.
  const password = crypto.randomUUID();
  await fx.pool.query(`ALTER ROLE isaflow_service LOGIN PASSWORD '${password}'`);
  const url = new URL(process.env.DATABASE_URL!);
  url.username = 'isaflow_service';
  url.password = password;
  vi.stubEnv('SERVICE_DATABASE_URL', url.toString());
  vi.stubEnv('SMTP_HOST', 'smtp.wp7-mock.invalid');
  vi.stubEnv('SMTP_USER', 'wp7-mock');
  vi.stubEnv('SMTP_PASS', 'wp7-mock');
  await fx.setup();
}, 60000);
afterAll(async () => {
  vi.unstubAllEnvs();
  await getPool().end();
  await fx.pool.query('ALTER ROLE isaflow_service NOLOGIN PASSWORD NULL'); // back to 915's state
  await fx.teardown();
}, 60000);

const logged = async (subject: string) =>
  (await fx.pool.query('SELECT status, email_type, sent_by FROM email_log WHERE company_id=$1 AND subject=$2', [fx.company, subject])).rows;

describe('email_log through the bare pool as isaflow_service', () => {
  it('the bare pool really is isaflow_service, not the fixture superuser', async () => {
    const { rows } = await getPool().query('SELECT session_user::text AS s, current_user::text AS c');
    expect(rows[0]).toEqual({ s: 'isaflow_service', c: 'isaflow_service' });
  });

  it('logEmailAttempt outside any request lands its row', async () => {
    const subject = `WP7 RLS direct ${crypto.randomUUID()}`;
    await logEmailAttempt({ companyId: fx.company, recipientEmail: fx.billing, subject, emailType: 'invoice', status: 'sent', sentBy: fx.admin });
    expect(await logged(subject)).toEqual([{ status: 'sent', email_type: 'invoice', sent_by: fx.admin }]);
  });

  it("a Send's email_log row lands through the same pool", async () => {
    const id = await fx.draft();
    const number = (await fx.row(id)).invoice_number as string;
    fx.expectStatus(await fx.call(sendRoute as never, { confirmed_to: fx.billing }, id), 200);
    const subject = String(mail.sendMail.mock.calls.at(-1)![0].subject);
    expect(subject).toContain(number);
    expect(await logged(subject)).toEqual([{ status: 'sent', email_type: 'invoice', sent_by: fx.admin }]);
  }, 60000);
});
