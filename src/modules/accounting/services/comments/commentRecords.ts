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

/** The company's record, or null when it is not there (or is another company's). */
export async function findCommentRecord(companyId: string, type: CommentRecordType, id: string): Promise<CommentRecord | null> {
  let rows: DbRow[];
  if (type === 'customer_invoice') {
    rows = (await sql`SELECT invoice_number AS label FROM customer_invoices
                       WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
    return rows[0] ? { label: `invoice ${String(rows[0].label)}`, href: `/accounting/customer-invoices/${id}` } : null;
  }
  if (type === 'supplier_invoice') {
    rows = (await sql`SELECT invoice_number AS label FROM supplier_invoices
                       WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
    return rows[0] ? { label: `bill ${String(rows[0].label)}`, href: `/accounting/supplier-invoices/${id}` } : null;
  }
  rows = (await sql`SELECT COALESCE(NULLIF(btrim(description), ''), 'bank line') AS label, bank_account_id::TEXT AS account_id FROM bank_transactions
                     WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  return rows[0] ? { label: `bank line "${String(rows[0].label).slice(0, 60)}"`, href: `/accounting/bank-transactions?account_id=${String(rows[0].account_id)}&line=${id}` } : null;
}
