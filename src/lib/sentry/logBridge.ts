// Logger -> Sentry bridge. logger.error(...) calls were journal-only; this sends the unexpected ones to Bugsink.
// Events go through the same beforeSend scrub (scrubEvent) as every other event. Only the message (emails redacted)
// and the Error are sent: log `data` is never attached. scrubText covers URLs and selectors, not free text, so a
// message that interpolates other personal values is still sent as written: keep those out of log messages.
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

// The Error itself, or one held at the top level of data or one object down ({ details: { err } }).
function findError(data: object | undefined): Error | undefined {
  if (!data) return undefined;
  if (data instanceof Error) return data;
  const values = Object.values(data);
  for (const v of values) if (v instanceof Error) return v;
  for (const v of values) {
    if (v && typeof v === 'object') for (const w of Object.values(v)) if (w instanceof Error) return w;
  }
  return undefined;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// The API handler's default log message when none is given: it says nothing and would group every such line together.
const GENERIC_MESSAGES = new Set(['error']);

function topFrame(err: Error): string {
  return (err.stack ?? '').split('\n').find((l) => l.trim().startsWith('at ')) ?? '';
}

function pick(data: object | undefined, ...keys: string[]): string | undefined {
  const rec = (data ?? {}) as Record<string, unknown>;
  for (const k of keys) if (typeof rec[k] === 'string' && rec[k]) return rec[k] as string;
  return undefined;
}

function isExpectedRejection(data: object | undefined, err: Error | undefined): boolean {
  const rec = (data ?? {}) as Record<string, unknown>;
  const status = rec.statusCode ?? rec.status;
  // A 4xx the code reports is an answered rejection (including 401/403 auth refusals), not a bug to page on.
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

  if (!err && GENERIC_MESSAGES.has(message)) return;

  const fingerprint = `${component ?? 'none'}::${normalizeMessage(message)}`;
  // Different errors behind one log line stay different issues and are limited separately.
  const limitKey = err ? `${fingerprint}::${err.name}::${topFrame(err)}` : fingerprint;
  if (rateLimited(limitKey, Date.now())) return;

  try {
    Sentry.withScope((scope) => {
      scope.setFingerprint(err ? ['{{ default }}', fingerprint] : [fingerprint]);
      if (component) scope.setTag('component', component);
      const companyId = pick(data, 'companyId', 'company_id');
      const userId = pick(data, 'userId', 'user_id');
      if (companyId) scope.setTag('company_id', companyId);
      if (userId) scope.setTag('user_id', userId);
      if (requestId) scope.setTag('request_id', requestId);
      if (err) Sentry.captureException(err);
      else Sentry.captureMessage(message.replace(EMAIL_RE, '<email>'), 'error');
    });
  } catch {
    // Reporting must never break the caller; the journal line is already written.
  }
}
