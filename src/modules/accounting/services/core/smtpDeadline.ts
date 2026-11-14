/**
 * A hard ceiling on one SMTP send (sendEmail's `deadlineMs`). nodemailer's connection / greeting / socket timeouts
 * are inactivity timers: each restarts on every reply, so a slow server can keep one send going for minutes. Past
 * the deadline `close` runs (sendEmail destroys the socket it handed nodemailer: transporter.close() alone does not
 * stop a non-pooled send in flight) and the send rejects with SendDeadlineError. Its outcome is UNKNOWN: the
 * server may already have accepted the message, so the code is not one quotaUse treats as "not sent".
 */
import { log } from '@/lib/logger';

export class SendDeadlineError extends Error {
  readonly code = 'EDEADLINE';
  constructor(ms: number) {
    super(`SMTP send exceeded its ${ms} ms deadline; whether the message was accepted is unknown`);
    this.name = 'SendDeadlineError';
  }
}

export async function withSendDeadline<T>(sending: Promise<T>, deadlineMs: number, close: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      try {
        close();
      } catch (err) {
        log.warn('SMTP transport close after the deadline failed', { message: err instanceof Error ? err.message : String(err) }, 'emailService');
      }
      reject(new SendDeadlineError(deadlineMs));
    }, deadlineMs);
  });
  try {
    return await Promise.race([sending, deadline]);
  } finally {
    clearTimeout(timer);
    // The abandoned send still settles (the close makes it reject): observe it so it is never unhandled.
    if (expired) {
      sending.then(
        () => log.warn('SMTP send completed AFTER its deadline (the claim stays; settle it from the email log)', {}, 'emailService'),
        (err: unknown) => log.info('SMTP send settled after its deadline', { message: err instanceof Error ? err.message : String(err) }, 'emailService'),
      );
    }
  }
}
