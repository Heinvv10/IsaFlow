/**
 * The unsaved invoice preview's request body (POST /api/accounting/invoice-pdf-preview): the body create takes
 * (customer-invoices-create), checked for shape and size before anything is read. Pure: no query here.
 *
 * Caps: 64 KB of JSON and 200 lines. The line coding (glAccountId, projectId, cc1Id, cc2Id, buId on a line) is not
 * read at all: the PDF prints none of it, so a preview never looks it up. The header projectId is read: the PDF prints
 * the job's name (invoicePreviewModel looks it up within the company).
 */
import { UUID_RE } from '@/lib/validation';

export const PREVIEW_MAX_BYTES = 64 * 1024;
export const PREVIEW_MAX_LINES = 200;

/** The preview's rate-limit name: one bucket per company, apart from invoice-pdf's per-user one. */
export const previewRateLimitName = (companyId: string): string => `invoice-pdf-preview:c:${companyId}`;

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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const blank = (v: unknown): boolean => v === undefined || v === null || v === '';

function optionalDate(v: unknown, field: string): string | null {
  if (blank(v)) return null;
  if (typeof v !== 'string' || !ISO_DATE.test(v)) throw new PreviewBodyError(`${field} must be a date (YYYY-MM-DD)`);
  return v;
}

/** The body, or a PreviewBodyError (a 400) naming the first thing wrong with it. */
export function parsePreviewBody(raw: unknown): PreviewBody {
  if (!isRecord(raw)) throw new PreviewBodyError('The preview needs the invoice as a JSON object');
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > PREVIEW_MAX_BYTES) {
    throw new PreviewBodyError(`The invoice is too large to preview (over ${PREVIEW_MAX_BYTES / 1024} KB)`);
  }
  const { clientId, items, taxRate, notes, exchangeRate, projectId } = raw;
  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) throw new PreviewBodyError('Select a client');
  if (!Array.isArray(items) || items.length === 0) throw new PreviewBodyError('Add at least one line item');
  if (items.length > PREVIEW_MAX_LINES) throw new PreviewBodyError(`The preview takes at most ${PREVIEW_MAX_LINES} lines`);
  const lines = items.map((item: unknown, i): PreviewLine => {
    if (!isRecord(item)) throw new PreviewBodyError(`Line ${i + 1} is not a line item`);
    if (typeof item.description !== 'string') throw new PreviewBodyError(`Line ${i + 1} needs a description`);
    return { description: item.description, quantity: item.quantity, unitPrice: item.unitPrice, discount: item.discount };
  });
  if (!(taxRate === undefined || typeof taxRate === 'number')) throw new PreviewBodyError('taxRate must be a number');
  if (!(blank(notes) || typeof notes === 'string')) throw new PreviewBodyError('notes must be text');
  if (!(blank(exchangeRate) || (typeof exchangeRate === 'number' && Number.isFinite(exchangeRate) && exchangeRate > 0))) {
    throw new PreviewBodyError('exchangeRate must be a positive number');
  }
  const job = typeof projectId === 'string' && UUID_RE.test(projectId) ? projectId.toLowerCase() : null;
  return {
    clientId: clientId.toLowerCase(),
    invoiceDate: optionalDate(raw.invoiceDate, 'invoiceDate'),
    dueDate: optionalDate(raw.dueDate, 'dueDate'),
    taxRate,
    notes: typeof notes === 'string' && notes !== '' ? notes : null,
    items: lines,
    currencyCode: raw.currencyCode,
    exchangeRate: blank(exchangeRate) ? undefined : exchangeRate as number,
    projectId: job,
    projectNamed: !blank(projectId),
  };
}
