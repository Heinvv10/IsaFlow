/**
 * Company Settings Service
 * Document numbers, messages, and per-company configuration.
 * Extracted from companyService.ts for file-size compliance.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { als, assertTxUsable } from '@/lib/als';

// ── Document Numbers ──────────────────────────────────────────────────────────

export interface DocumentNumber {
  id: string;
  companyId: string;
  documentType: string;
  prefix: string;
  nextNumber: number;
  padding: number;
}

const DEFAULT_DOC_NUMBERS: { type: string; prefix: string }[] = [
  { type: 'quotation', prefix: 'QUO' },
  { type: 'sales_order', prefix: 'SO' },
  { type: 'customer_invoice', prefix: 'INV' },
  { type: 'credit_note', prefix: 'CRN' },
  { type: 'customer_receipt', prefix: 'RCP' },
  { type: 'customer_write_off', prefix: 'WRI' },
  { type: 'customer_adjustment', prefix: 'CADJ' },
  { type: 'purchase_order', prefix: 'PO' },
  { type: 'supplier_invoice', prefix: 'SIV' },
  { type: 'supplier_return', prefix: 'RTN' },
  { type: 'supplier_payment', prefix: 'PAY' },
  { type: 'supplier_adjustment', prefix: 'SADJ' },
  { type: 'delivery_note', prefix: 'DN' },
];

/**
 * Types the settings screen must no longer offer, because nothing reserves from
 * them any more.
 *
 * 'recurring_invoice' (prefix RINV) was the recurring runner's own sequence.
 * Both recurring paths now mint from 'customer_invoice' — the same sequence
 * every other writer of that table uses — so the row was left showing a prefix
 * and a next-number the user could edit to no effect whatsoever. A tenant that
 * customised RINV to match their stationery would have found new recurring
 * invoices coming out as INV0000123 anyway. Filtered on read rather than
 * deleted: the row carries the historical counter for existing
 * RINV-<slug>-<YYYYMM> documents, and dropping it is not reversible.
 */
const RETIRED_DOC_NUMBER_TYPES = new Set(['recurring_invoice']);

/** True for a document type the settings screen no longer shows or accepts. */
export function isRetiredDocumentNumberType(documentType: string): boolean {
  return RETIRED_DOC_NUMBER_TYPES.has(documentType);
}

export async function getDocumentNumbers(companyId: string): Promise<DocumentNumber[]> {
  const rows = ((await sql`
    SELECT * FROM company_document_numbers WHERE company_id = ${companyId}::UUID ORDER BY document_type
  `) as Record<string, unknown>[])
    .filter((r) => !RETIRED_DOC_NUMBER_TYPES.has(String(r.document_type)));
  return rows.map((r: Record<string, unknown>) => ({
    id: String(r.id), companyId: String(r.company_id), documentType: String(r.document_type),
    prefix: String(r.prefix), nextNumber: Number(r.next_number), padding: Number(r.padding),
  }));
}

export async function ensureDocumentNumbers(companyId: string): Promise<DocumentNumber[]> {
  for (const d of DEFAULT_DOC_NUMBERS) {
    await sql`
      INSERT INTO company_document_numbers (company_id, document_type, prefix, next_number, padding)
      VALUES (${companyId}::UUID, ${d.type}, ${d.prefix}, 1, 7)
      ON CONFLICT (company_id, document_type) DO NOTHING
    `;
  }
  return getDocumentNumbers(companyId);
}

export async function updateDocumentNumber(
  companyId: string,
  documentType: string,
  prefix: string,
  nextNumber?: number,
): Promise<void> {
  if (nextNumber !== undefined) {
    await sql`
      UPDATE company_document_numbers SET prefix = ${prefix}, next_number = ${nextNumber}
      WHERE company_id = ${companyId}::UUID AND document_type = ${documentType}
    `;
  } else {
    await sql`
      UPDATE company_document_numbers SET prefix = ${prefix}
      WHERE company_id = ${companyId}::UUID AND document_type = ${documentType}
    `;
  }
}

/**
 * Format `${prefix}${zero-padded number}` exactly as the settings preview shows it.
 */
export function formatDocumentNumber(prefix: string, number: number, padding: number): string {
  return `${prefix}${String(number).padStart(padding, '0')}`;
}

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Raised when another request has held this company's counter row for the type
 * longer than the 5s `lock_timeout`.
 *
 * The counter row lock is held until the holder's request COMMITs — that is
 * inherent to a gapless per-company sequence, and correctness beats throughput
 * — but the WAIT must be bounded. Nothing sets lock_timeout globally, so a
 * request that stalls while holding the row blocked every other document
 * creation for that company indefinitely, with no error and no 409: it simply
 * hung. A typed error at 5s makes the contention visible and retryable.
 */
export class DocumentNumberLockTimeoutError extends Error {
  readonly code = 'DOCUMENT_NUMBER_LOCK_TIMEOUT';
  constructor(public readonly documentType: string) {
    super(`The ${documentType} number sequence is in use by another request — retry in a moment.`);
    this.name = 'DocumentNumberLockTimeoutError';
  }
}

/**
 * Atomically reserve the next number in a company's sequence and return it formatted.
 * Increments next_number under a SQL UPDATE...RETURNING so concurrent calls cannot collide.
 */
export async function reserveNextDocumentNumber(
  companyId: string,
  documentType: string,
): Promise<string> {
  // Bounded wait on the counter row (see DocumentNumberLockTimeoutError).
  // Re-issued every call, never memoised: SET LOCAL is subtransaction-aware and
  // a savepoint rollback restores it to 0 — no timeout at all — and every
  // retry attempt in insertWithReservedNumber runs in its own savepoint.
  // Skipped outside a request transaction, where SET LOCAL affects nothing.
  const client = als.getStore()?.client;
  if (client) {
    assertTxUsable();
    await client.query("SET LOCAL lock_timeout = '5s'");
  }
  try {
    return await reserveNextDocumentNumberInner(companyId, documentType, client);
  } catch (err) {
    if (typeof err === 'object' && err !== null
      && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
      throw new DocumentNumberLockTimeoutError(documentType);
    }
    throw err;
  }
}

async function reserveNextDocumentNumberInner(
  companyId: string,
  documentType: string,
  client: { query: (text: string) => Promise<unknown> } | undefined,
): Promise<string> {
  // Hot path: try the UPDATE first. If the row exists (the common case once
  // ensureDocumentNumbers has run for this company even once), we incur a single
  // round-trip. Only when the row is missing do we fall back to seeding.
  // Concurrent first-time callers are safe: ensureDocumentNumbers uses
  // `INSERT ... ON CONFLICT DO NOTHING`, so seeding is idempotent and the
  // post-seed UPDATE atomically reserves a unique slot per caller.
  let rows = (await sql`
    UPDATE company_document_numbers
       SET next_number = next_number + 1
     WHERE company_id = ${companyId}::UUID AND document_type = ${documentType}
     RETURNING (next_number - 1) AS used, prefix, padding
  `) as Record<string, unknown>[];
  if (rows.length === 0) {
    await ensureDocumentNumbers(companyId);
    rows = (await sql`
      UPDATE company_document_numbers
         SET next_number = next_number + 1
       WHERE company_id = ${companyId}::UUID AND document_type = ${documentType}
       RETURNING (next_number - 1) AS used, prefix, padding
    `) as Record<string, unknown>[];
  }
  if (rows.length === 0) {
    throw new Error(`No document number config for type ${documentType}`);
  }
  // Restored on the SUCCESS path only. After a lock timeout the transaction is
  // aborted and this statement would itself raise 25P02, replacing the typed
  // error with an opaque one. Left set, the 5s ceiling would leak onto every
  // later statement in the request.
  if (client) await client.query('SET LOCAL lock_timeout = DEFAULT');
  return formatDocumentNumber(
    String(rows[0]!.prefix),
    Number(rows[0]!.used),
    Number(rows[0]!.padding),
  );
}

/**
 * Peek (read-only) the next number that would be reserved for a document type.
 * Use this for UI pre-fill — does NOT consume the number.
 */
export async function peekNextDocumentNumber(
  companyId: string,
  documentType: string,
): Promise<string> {
  let rows = (await sql`
    SELECT prefix, next_number, padding
      FROM company_document_numbers
     WHERE company_id = ${companyId}::UUID AND document_type = ${documentType}
  `) as Record<string, unknown>[];
  if (rows.length === 0) {
    await ensureDocumentNumbers(companyId);
    rows = (await sql`
      SELECT prefix, next_number, padding
        FROM company_document_numbers
       WHERE company_id = ${companyId}::UUID AND document_type = ${documentType}
    `) as Record<string, unknown>[];
  }
  if (rows.length === 0) {
    throw new Error(`No document number config for type ${documentType}`);
  }
  return formatDocumentNumber(
    String(rows[0]!.prefix),
    Number(rows[0]!.next_number),
    Number(rows[0]!.padding),
  );
}

// ── Company Messages ──────────────────────────────────────────────────────────

export interface CompanyMessage {
  messageType: string;
  message: string;
}

export async function getCompanyMessages(companyId: string): Promise<CompanyMessage[]> {
  const rows = (await sql`
    SELECT message_type, message FROM company_messages WHERE company_id = ${companyId}::UUID ORDER BY message_type
  `) as Record<string, unknown>[];
  return rows.map((r: Record<string, unknown>) => ({
    messageType: String(r.message_type ?? ''),
    message: String(r.message ?? ''),
  }));
}

export async function upsertCompanyMessage(
  companyId: string,
  messageType: string,
  message: string,
): Promise<void> {
  await sql`
    INSERT INTO company_messages (company_id, message_type, message)
    VALUES (${companyId}::UUID, ${messageType}, ${message})
    ON CONFLICT (company_id, message_type) DO UPDATE SET message = ${message}, updated_at = NOW()
  `;
  log.info('Upserted company message', { companyId, messageType }, 'accounting');
}

export async function upsertCompanyMessages(
  companyId: string,
  messages: CompanyMessage[],
): Promise<void> {
  for (const m of messages) {
    await upsertCompanyMessage(companyId, m.messageType, m.message);
  }
}
