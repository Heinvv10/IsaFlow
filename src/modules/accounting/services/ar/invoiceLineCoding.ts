/**
 * What a customer invoice line is CODED to: the revenue account it credits and
 * the job (`projects`, what Project Profitability, WIP and time read) its
 * revenue is tagged with. Both optional. The line's CC1 / CC2 / BU are the
 * dimensions model's (migration 870, gl/dimensions); a line naming none of the
 * five posts to the company's `default_revenue` account, exactly as every
 * invoice did before migration 874.
 *
 * Pure — no DB. Every write path reads the caller's ids through
 * `parseLineCoding` before anything else touches them; ownership and account
 * rules are `invoiceLineCodingGuard.ts`.
 *
 * Body-coercion lesson: `String(['<uuid>'])` is a valid uuid string, so a value
 * is accepted only when it is ALREADY a string of uuid shape — an array,
 * number or object is refused, never coerced.
 */
import { UUID_RE } from '@/lib/validation';

export interface InvoiceLineCoding {
  glAccountId: string | null;
  projectId: string | null;
}

/** The body keys a caller names the account and the job by. */
export interface CodingKeys {
  account: string;
  project: string;
}

export const HTTP_CODING_KEYS: CodingKeys = { account: 'glAccountId', project: 'projectId' };
export const MCP_CODING_KEYS: CodingKeys = { account: 'gl_account_id', project: 'project_id' };

/**
 * Raised when a line's coding cannot be accepted or posted. The code lets the
 * message reach an MCP caller (refusalCodes.ts); it names only the caller's own
 * account or job.
 */
export class InvoiceLineCodingRefusal extends Error {
  readonly code = 'INVOICE_LINE_CODING_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceLineCodingRefusal';
  }
}

/**
 * Raised when the FOR SHARE read of the lines' GL accounts lost a lock race:
 * 55P03 (its wait outlived lock_timeout) or 40P01 (deadlock victim — approve and
 * draft edit lock the invoice, then the accounts; an account merge locks the
 * accounts, then the invoices). Retryable; nothing about the request is wrong.
 * The `_LOCK_TIMEOUT` code is what makes a route answer 503 + Retry-After
 * (respondIfLockTimeout: a 4xx would COMMIT the aborted transaction), the MCP
 * registry show its message, and bulk finalize skip the element as retryable.
 */
export class InvoiceLineAccountLockError extends Error {
  readonly code = 'INVOICE_LINE_ACCOUNT_LOCK_TIMEOUT';
  constructor(options?: { cause?: unknown }) {
    super('Another request is changing the GL accounts these invoice lines use — retry in a moment.', options);
    this.name = 'InvoiceLineAccountLockError';
  }
}

/** null when absent, the lower-cased id when a uuid string, undefined when anything else. */
export function readCodingId(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) return undefined;
  return value.toLowerCase();
}

/** The line's coding, or the refusal naming the field (`items[2].projectId must be a UUID`). */
export function parseLineCoding(
  line: Record<string, unknown>,
  keys: CodingKeys,
  where: string,
): InvoiceLineCoding | string {
  const glAccountId = readCodingId(line[keys.account]);
  if (glAccountId === undefined) return `${where}.${keys.account} must be a UUID`;
  const projectId = readCodingId(line[keys.project]);
  if (projectId === undefined) return `${where}.${keys.project} must be a UUID`;
  return { glAccountId, projectId };
}

/** The line names an account or a job (its CC1 / CC2 / BU are `hasDimensions`). */
export function isCoded(c: InvoiceLineCoding): boolean {
  return c.glAccountId !== null || c.projectId !== null;
}
