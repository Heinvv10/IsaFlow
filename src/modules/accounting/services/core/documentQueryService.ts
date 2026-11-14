/**
 * Reading the document stores. `attach_document` and the documents upload
 * endpoint both WRITE and nothing read them back over the API, so
 * "which transactions over R10,000 have no supporting document" — a standard
 * audit test — has been unanswerable.
 *
 * There are TWO stores and they are not interchangeable:
 *
 *  - `bank_transaction_attachments` — what attach_document writes. No
 *    company_id column; the tenant fence is the parent bank transaction, so
 *    every query here joins bank_transactions and filters on ITS company_id.
 *  - `procurement_documents` (+ `document_links`) — what the documents upload
 *    endpoint writes, keyed by (entity_type, entity_id). Also no company_id,
 *    and no parent table it can be joined to generically — which is why an
 *    entity listing must call verifyEntityOwnership FIRST and refuse before
 *    reading. That ordering is the fence; do not reorder it.
 *
 * Extracted from pages/api/accounting/documents.ts, which is now a caller.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { hasBankLineDocumentSql } from '../bank/bankLineDocumentSql';
import { entityTableName, hasEntityDocumentSql } from './documentPresenceSql';
import type { AccountingEntityType, LinkedDocument } from '@/types/procurement/document.types';
import {
  VALID_ENTITY_TYPES,
  mapRow,
  verifyEntityOwnership,
} from './documentStorageService';

export type EntityDocumentsResult =
  | { ok: true; documents: LinkedDocument[]; hasMore: boolean }
  | { ok: false; reason: 'invalid_entity_type' | 'entity_not_found' };

/**
 * Direct + cross-linked documents for one accounting entity.
 *
 * The cap is per query and the merged result is at most 2×limit — the two
 * stores are paged independently because they have different orderings and a
 * merged keyset over both would need a shared sort key they do not have.
 */
export async function listEntityDocuments(
  companyId: string,
  entityType: string,
  entityId: string,
  limit: number,
  offset: number,
): Promise<EntityDocumentsResult> {
  if (!(VALID_ENTITY_TYPES as readonly string[]).includes(entityType)) {
    return { ok: false, reason: 'invalid_entity_type' };
  }
  // BEFORE any read: procurement_documents cannot fence itself.
  if (!(await verifyEntityOwnership(entityId, companyId))) {
    return { ok: false, reason: 'entity_not_found' };
  }

  const directRows = (await sql`
    SELECT * FROM procurement_documents
    WHERE entity_type = ${entityType}
      AND entity_id = ${entityId}::uuid
      AND is_active = true
    ORDER BY uploaded_at DESC, id DESC
    LIMIT ${limit + 1} OFFSET ${offset}
  `) as DbRow[];

  const linkedRows = (await sql`
    SELECT pd.*, dl.link_reason
    FROM document_links dl
    JOIN procurement_documents pd ON pd.id = dl.document_id
    WHERE dl.linked_entity_type = ${entityType}
      AND dl.linked_entity_id = ${entityId}::uuid
      AND pd.is_active = true
    ORDER BY pd.uploaded_at DESC, pd.id DESC
    LIMIT ${limit + 1} OFFSET ${offset}
  `) as DbRow[];

  return {
    ok: true,
    hasMore: directRows.length > limit || linkedRows.length > limit,
    documents: [
      ...directRows.slice(0, limit).map((r) => mapRow(r as Record<string, unknown>, 'direct')),
      ...linkedRows.slice(0, limit).map((r) =>
        mapRow(r as Record<string, unknown>, 'linked', r.link_reason as string)),
    ],
  };
}

/**
 * Which of `ids` carry at least one supporting document (core/documentPresenceSql: the entity store, directly or
 * through document_links, plus a bill's or invoice's source captured document). ONE query for a whole export page.
 * The fence is the entity's own table: an id counts only when it is a row of `entityType`'s table AND belongs to
 * `companyId`, so a foreign or mistyped id never reads procurement_documents.
 */
export async function entityIdsWithDocuments(
  companyId: string,
  entityType: AccountingEntityType,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = (await sql`
    SELECT e.id FROM ${sql.unsafe(entityTableName(entityType))} e
    WHERE e.company_id = ${companyId}::uuid AND e.id = ANY(${ids as string[]}::uuid[])
      AND ${sql.unsafe(hasEntityDocumentSql(entityType, 'e'))}
  `) as DbRow[];
  return new Set(rows.map((r) => String(r.id)));
}

// Bank-line documents (uploads and linked captured documents) live in ./bankAttachmentQuery.
export { listBankAttachments } from './bankAttachmentQuery';
export type { BankAttachmentRow, AttachmentFilters, AttachmentPage } from './bankAttachmentQuery';

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

export interface UnsupportedTxRow {
  id: string;
  transactionDate: string;
  amount: number;
  description: string;
  reference: string | null;
  status: string;
}

export interface UnsupportedFilters {
  from: string;
  to: string;
  /** Compared against ABS(amount): money out is as material as money in. */
  minAmount: number;
  limit: number;
}

export interface UnsupportedPage {
  rows: UnsupportedTxRow[];
  rowsTotal: number;
  /** Transactions in range over the threshold, supported or not. */
  universeTotal: number;
  postedThrough: string;
}

/**
 * Bank transactions over a materiality threshold with NO supporting document: no upload and no linked captured
 * document (bank/bankLineDocumentSql, the same definition as the grid's paperclip).
 */
export async function listTransactionsWithoutDocuments(
  companyId: string,
  f: UnsupportedFilters,
): Promise<UnsupportedPage> {
  try {
    const rows = (await sql`
      SELECT bt.id, bt.transaction_date, bt.amount, bt.description, bt.reference, bt.status
      FROM bank_transactions bt
      WHERE bt.company_id = ${companyId}::UUID
        AND bt.transaction_date >= ${f.from}::DATE
        AND bt.transaction_date <= ${f.to}::DATE
        AND ABS(bt.amount) >= ${f.minAmount}
        AND bt.feed_state = 'posted'
        AND NOT ${sql.unsafe(hasBankLineDocumentSql('bt'))}
      ORDER BY ABS(bt.amount) DESC, bt.id DESC
      LIMIT ${f.limit}
    `) as DbRow[];

    const [unsupported] = (await sql`
      SELECT COUNT(*) AS cnt, MAX(bt.created_at) AS latest
      FROM bank_transactions bt
      WHERE bt.company_id = ${companyId}::UUID
        AND bt.transaction_date >= ${f.from}::DATE
        AND bt.transaction_date <= ${f.to}::DATE
        AND ABS(bt.amount) >= ${f.minAmount}
        AND bt.feed_state = 'posted'
        AND NOT ${sql.unsafe(hasBankLineDocumentSql('bt'))}
    `) as DbRow[];

    const [universe] = (await sql`
      SELECT COUNT(*) AS cnt FROM bank_transactions bt
      WHERE bt.company_id = ${companyId}::UUID
        AND bt.transaction_date >= ${f.from}::DATE
        AND bt.transaction_date <= ${f.to}::DATE
        AND ABS(bt.amount) >= ${f.minAmount}
        AND bt.feed_state = 'posted'
    `) as DbRow[];

    return {
      rows: rows.map((r) => ({
        id: String(r.id),
        transactionDate: fmtDate(r.transaction_date),
        amount: Number(r.amount ?? 0),
        description: String(r.description ?? ''),
        reference: r.reference != null ? String(r.reference) : null,
        status: String(r.status ?? ''),
      })),
      rowsTotal: Number(unsupported?.cnt ?? 0),
      universeTotal: Number(universe?.cnt ?? 0),
      postedThrough: unsupported?.latest != null ? iso(unsupported.latest) : new Date(0).toISOString(),
    };
  } catch (err) {
    log.error('Failed to list unsupported transactions', { companyId, error: err }, 'accounting');
    throw err;
  }
}
