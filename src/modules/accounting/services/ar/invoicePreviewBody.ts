/**
 * The unsaved invoice preview's request body (POST /api/accounting/invoice-pdf-preview): the body create takes
 * (customer-invoices-create), checked for shape and size before anything is read. Pure: no query here.
 *
 * Caps: 64 KB of JSON and 200 lines; a line description and the notes at most 2,000 characters and 20 line breaks each
 * (a PDF page per few breaks: 200 lines of 120 breaks drew 327 pages). Dates are real calendar dates (create's
 * assertDraftDates rule); a null taxRate is create's default. The line coding (glAccountId, projectId, cc1Id, cc2Id, buId on a line) is not
 * read at all: the PDF prints none of it, so a preview never looks it up. The header projectId is read: the PDF prints
 * the job's name (invoicePreviewModel looks it up within the company).
 */
import { isRealCalendarDate, UUID_RE } from '@/lib/validation';

export const PREVIEW_MAX_BYTES = 64 * 1024;
export const PREVIEW_MAX_LINES = 200;
export const PREVIEW_MAX_TEXT_CHARS = 2000;
export const PREVIEW_MAX_TEXT_LINE_BREAKS = 20;

/**
 * The preview's rate-limit name: each member's own bucket within the company (checkReportRateLimit stores it as
 * `report:invoice-pdf-preview:u:<userId>:co:<companyId>`), apart from invoice-pdf's `invoice-pdf:u:` one.
 */
export const previewRateLimitName = (userId: string): string => `invoice-pdf-preview:u:${userId}`;
/** 300 per 15 min: the most the new page's 3 s refetch can ask for in the window. */
export const PREVIEW_RATE_LIMIT = { max: 300, windowSecs: 900 } as const;

export interface PreviewLine { description: string; quantity: unknown; unitPrice: unknown; discount: unknown }

export interface PreviewBody {
  clientId: string;
  invoiceDate: string | null;
  dueDate: string | null;
  taxRate: number | undefined;
  notes: string | null;
  items: PreviewLine[];
  currencyCode: unknown;
  /** Absent, or a positive finite number (checked here); the currency rule is the company's (invoicePreviewModel). */
  exchangeRate: number | undefined;
  /** The header job: a UUID, or null when none or not a UUID (then the preview notes it as not recognised). */
  projectId: string | null;
  projectNamed: boolean;
}

export class PreviewBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewBodyError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const blank = (v: unknown): boolean => v === undefined || v === null || v === '';

function optionalDate(v: unknown, field: string): string | null {
  if (blank(v)) return null;
  if (typeof v !== 'string' || !isRealCalendarDate(v)) throw new PreviewBodyError(`${field} must be a date (YYYY-MM-DD)`);
  return v;
}

/** `text` within the caps, or a PreviewBodyError opening with `tooLong` ("The notes are") or `tooManyLines` ("The notes have"). */
function capText(text: string, tooLong: string, tooManyLines: string): void {
  if (text.length > PREVIEW_MAX_TEXT_CHARS) {
    throw new PreviewBodyError(`${tooLong} too long to preview (over ${PREVIEW_MAX_TEXT_CHARS} characters)`);
  }
  if ((text.match(/\r\n|\r|\n/g)?.length ?? 0) > PREVIEW_MAX_TEXT_LINE_BREAKS) {
    throw new PreviewBodyError(`${tooManyLines} too many lines to preview (over ${PREVIEW_MAX_TEXT_LINE_BREAKS} line breaks)`);
  }
}

/** The JSON size, or a PreviewBodyError when it cannot be measured (nested too deep for JSON.stringify). */
function jsonBytes(raw: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(raw), 'utf8');
  } catch (err) {
    // A RangeError (call stack) for a body nested thousands deep: the caller's 400, not a 500 before the rate limit.
    throw new PreviewBodyError(`The invoice cannot be previewed (${err instanceof Error ? err.name : 'unreadable'}): it is nested too deeply`);
  }
}

/** The body, or a PreviewBodyError (a 400) naming the first thing wrong with it. */
export function parsePreviewBody(raw: unknown): PreviewBody {
  if (!isRecord(raw)) throw new PreviewBodyError('The preview needs the invoice as a JSON object');
  if (jsonBytes(raw) > PREVIEW_MAX_BYTES) {
    throw new PreviewBodyError(`The invoice is too large to preview (over ${PREVIEW_MAX_BYTES / 1024} KB)`);
  }
  const { clientId, items, taxRate, notes, exchangeRate, projectId } = raw;
  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) throw new PreviewBodyError('Select a client');
  if (!Array.isArray(items) || items.length === 0) throw new PreviewBodyError('Add at least one line item');
  if (items.length > PREVIEW_MAX_LINES) throw new PreviewBodyError(`The preview takes at most ${PREVIEW_MAX_LINES} lines`);
  const lines = items.map((item: unknown, i): PreviewLine => {
    if (!isRecord(item)) throw new PreviewBodyError(`Line ${i + 1} is not a line item`);
    if (typeof item.description !== 'string') throw new PreviewBodyError(`Line ${i + 1} needs a description`);
    capText(item.description, `Line ${i + 1}'s description is`, `Line ${i + 1}'s description has`);
    return { description: item.description, quantity: item.quantity, unitPrice: item.unitPrice, discount: item.discount };
  });
  // null is create's default (15), as `taxRate ?? 15` takes it.
  if (!(taxRate === undefined || taxRate === null || typeof taxRate === 'number')) throw new PreviewBodyError('taxRate must be a number');
  if (!(blank(notes) || typeof notes === 'string')) throw new PreviewBodyError('notes must be text');
  if (typeof notes === 'string') capText(notes, 'The notes are', 'The notes have');
  if (!(blank(exchangeRate) || (typeof exchangeRate === 'number' && Number.isFinite(exchangeRate) && exchangeRate > 0))) {
    throw new PreviewBodyError('exchangeRate must be a positive number');
  }
  const job = typeof projectId === 'string' && UUID_RE.test(projectId) ? projectId.toLowerCase() : null;
  return {
    clientId: clientId.toLowerCase(),
    invoiceDate: optionalDate(raw.invoiceDate, 'invoiceDate'),
    dueDate: optionalDate(raw.dueDate, 'dueDate'),
    taxRate: taxRate ?? undefined,
    notes: typeof notes === 'string' && notes !== '' ? notes : null,
    items: lines,
    currencyCode: raw.currencyCode,
    exchangeRate: blank(exchangeRate) ? undefined : exchangeRate as number,
    projectId: job,
    projectNamed: !blank(projectId),
  };
}
