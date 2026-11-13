/**
 * The three kinds of record a comment hangs on (migration 986 record_type), and how to find them.
 * Every lookup names the company: a record of another company is "not found", never "forbidden".
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export const COMMENT_RECORD_TYPES = ['customer_invoice', 'supplier_invoice', 'bank_transaction'] as const;
export type CommentRecordType = (typeof COMMENT_RECORD_TYPES)[number];

export interface CommentRecord {
  /** What a mention's title calls the record: "invoice INV-001". */
  label: string;
  /** The in-app page a mention opens. */
  href: string;
}

export function isCommentRecordType(v: unknown): v is CommentRecordType {
  return typeof v === 'string' && (COMMENT_RECORD_TYPES as readonly string[]).includes(v);
}

/**
 * The in-app page a mention opens, and each page mounts the CommentsPanel for that record (tests/unit/components/
 * commentsMounts.test.tsx follows each href to its page): the full invoice page, the bill page, and the bank page
 * with `?line=` (its drawer, see useBankLineDeepLink).
 */
export function commentRecordHref(type: CommentRecordType, id: string, bankAccountId?: string): string {
  if (type === 'customer_invoice') return `/accounting/customer-invoices/${id}`;
  if (type === 'supplier_invoice') return `/accounting/supplier-invoices/${id}`;
  return `/accounting/bank-transactions?account_id=${bankAccountId ?? ''}&line=${id}`;
}

/** The company's record, or null when it is not there (or is another company's). */
export async function findCommentRecord(companyId: string, type: CommentRecordType, id: string): Promise<CommentRecord | null> {
  let rows: DbRow[];
  if (type === 'customer_invoice') {
    rows = (await sql`SELECT invoice_number AS label FROM customer_invoices
                       WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
    return rows[0] ? { label: `invoice ${String(rows[0].label)}`, href: commentRecordHref(type, id) } : null;
  }
  if (type === 'supplier_invoice') {
    rows = (await sql`SELECT invoice_number AS label FROM supplier_invoices
                       WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
    return rows[0] ? { label: `bill ${String(rows[0].label)}`, href: commentRecordHref(type, id) } : null;
  }
  rows = (await sql`SELECT COALESCE(NULLIF(btrim(description), ''), 'bank line') AS label, bank_account_id::TEXT AS account_id FROM bank_transactions
                     WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND feed_state <> 'removed'`) as DbRow[];
  return rows[0] ? { label: `bank line "${String(rows[0].label).slice(0, 60)}"`, href: commentRecordHref(type, id, String(rows[0].account_id)) } : null;
}
