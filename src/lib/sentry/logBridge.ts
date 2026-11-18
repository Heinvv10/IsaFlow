// Logger -> Sentry bridge. logger.error(...) calls were journal-only; this sends the unexpected ones to Bugsink.
// Events go through the same beforeSend scrub (scrubEvent) as every other event. Only the message and the Error
// are sent: log `data` is never attached, so no request values leave the box through this path.
import * as Sentry from '@sentry/nextjs';

export interface LogErrorInput {
  message: string;
  component?: string;
  requestId?: string;
  data?: object;
}

const WINDOW_MS = 60_000;
const MAX_TRACKED = 500;
const lastSent = new Map<string, number>();

// Expected input rejections: answered 4xx, not bugs. The API layer has no single class, so match by name / message.
const EXPECTED_NAME_RE = /ValidationError|ZodError|RequestError$/;
const EXPECTED_MESSAGE_RE = /^Invalid /;

export function resetLogBridgeForTests(): void {
  lastSent.clear();
}

/** The message with its interpolated values (uuids, numbers, quoted strings) replaced, so repeats group. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/(["'`]).*?\1/g, '<str>')
    .replace(/\d+(\.\d+)?/g, '<n>');
}

function findError(data: object | undefined): Error | undefined {
  if (!data) return undefined;
  for (const v of Object.values(data)) if (v instanceof Error) return v;
  return undefined;
}

function pick(data: object | undefined, ...keys: string[]): string | undefined {
  const rec = (data ?? {}) as Record<string, unknown>;
  for (const k of keys) if (typeof rec[k] === 'string' && rec[k]) return rec[k] as string;
  return undefined;
}

function isExpectedRejection(data: object | undefined, err: Error | undefined): boolean {
  const rec = (data ?? {}) as Record<string, unknown>;
  const status = rec.statusCode ?? rec.status;
  if (typeof status === 'number' && status >= 400 && status < 500) return true;
  if (!err) return false;
  return EXPECTED_NAME_RE.test(err.name) || EXPECTED_MESSAGE_RE.test(err.message);
}

function rateLimited(fingerprint: string, now: number): boolean {
  const last = lastSent.get(fingerprint);
  if (last !== undefined && now - last < WINDOW_MS) return true;
  if (lastSent.size >= MAX_TRACKED) {
    for (const [k, t] of lastSent) if (now - t >= WINDOW_MS) lastSent.delete(k);
    if (lastSent.size >= MAX_TRACKED) lastSent.clear();
  }
  lastSent.set(fingerprint, now);
  return false;
}

export function forwardLogError(input: LogErrorInput): void {
  if (process.env.SENTRY_ENABLED !== 'true') return;
  const { message, component, requestId, data } = input;
  // A call site that already captures the exception itself (withErrorHandler, deferredEnd) says so.
  if ((data as Record<string, unknown> | undefined)?.sentryCaptured === true) return;
  const err = findError(data);
  if (isExpectedRejection(data, err)) return;

  const fingerprint = `${component ?? 'none'}::${normalizeMessage(message)}`;
  if (rateLimited(fingerprint, Date.now())) return;

  try {
    Sentry.withScope((scope) => {
      scope.setFingerprint([fingerprint]);
      if (component) scope.setTag('component', component);
      const companyId = pick(data, 'companyId', 'company_id');
      const userId = pick(data, 'userId', 'user_id');
      if (companyId) scope.setTag('company_id', companyId);
      if (userId) scope.setTag('user_id', userId);
      if (requestId) scope.setTag('request_id', requestId);
      if (err) Sentry.captureException(err);
      else Sentry.captureMessage(message, 'error');
    });
  } catch {
    // Reporting must never break the caller; the journal line is already written.
  }
}
