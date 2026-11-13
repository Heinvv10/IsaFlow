/**
 * External references: find a document by the source system's own id, and make a create
 * idempotent on it (brief step 3, 13 Nov 2026).
 *
 * Migration 530 put external_ref / external_document_number / external_system on every document
 * table and deliberately did NOT make them unique: legacy imports can carry repeats, and a unique
 * index found mid-migration aborts it. So idempotency is enforced here instead:
 *
 *   lockExternalRef     pg_advisory_xact_lock on (company, kind, system, ref) — two concurrent creates
 *                       naming the same ref serialise; the second then sees the first's row.
 *   findByExternalRef   the rows carrying that ref (a live row first). A create that finds one returns
 *                       it instead of writing.
 *   stampExternalRef    writes the three columns onto the row the create just inserted, in the same
 *                       transaction, so a ref is never recorded for a create that rolled back.
 *
 * Every query is company-scoped. Table names are fixed per kind (no dynamic identifiers).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export const EXTERNAL_REF_KINDS = [
  'supplier_invoice', 'customer_invoice', 'credit_note', 'journal', 'bank_transaction', 'supplier', 'customer',
] as const;
export type ExternalRefKind = (typeof EXTERNAL_REF_KINDS)[number];

/** Sage's own document codes, accepted as kinds. ret/cret narrow credit notes to one side. */
export const EXTERNAL_REF_KIND_ALIASES: Record<string, { kind: ExternalRefKind; creditNoteType?: 'supplier' | 'customer' }> = {
  siv: { kind: 'supplier_invoice' },
  ti: { kind: 'customer_invoice' },
  ret: { kind: 'credit_note', creditNoteType: 'supplier' },
  cret: { kind: 'credit_note', creditNoteType: 'customer' },
  bank: { kind: 'bank_transaction' },
  je: { kind: 'journal' },
};

export interface ExternalRefMatch {
  entityType: ExternalRefKind;
  id: string;
  number: string | null;
  status: string | null;
  date: string | null;
  totalAmount: number | null;
  /** Soft-deleted or cancelled: kept so a caller can see it, never treated as the live copy. */
  live: boolean;
  externalDocumentNumber: string | null;
  creditNoteType?: string;
}

export interface ExternalRefValue {
  system: string;
  ref: string;
  documentNumber?: string | null;
}

const isoDate = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
};

async function rowsFor(companyId: string, kind: ExternalRefKind, system: string, ref: string): Promise<DbRow[]> {
  switch (kind) {
    case 'supplier_invoice':
      return (await sql`
        SELECT id, invoice_number AS number, status, invoice_date AS date, total_amount, external_document_number,
               (deleted_at IS NULL AND status IS DISTINCT FROM 'cancelled') AS live
        FROM supplier_invoices
        WHERE company_id = ${companyId}::UUID AND external_system = ${system} AND external_ref = ${ref}`) as DbRow[];
    case 'customer_invoice':
      return (await sql`
        SELECT id, invoice_number AS number, status, invoice_date AS date, total_amount, external_document_number,
               (deleted_at IS NULL AND status IS DISTINCT FROM 'cancelled') AS live
        FROM customer_invoices
        WHERE company_id = ${companyId}::UUID AND external_system = ${system} AND external_ref = ${ref}`) as DbRow[];
    case 'credit_note':
      return (await sql`
        SELECT id, credit_note_number AS number, status, credit_date AS date, total_amount, external_document_number,
               type AS credit_note_type, (status IS DISTINCT FROM 'cancelled') AS live
        FROM credit_notes
        WHERE company_id = ${companyId}::UUID AND external_system = ${system} AND external_ref = ${ref}`) as DbRow[];
    case 'journal':
      return (await sql`
        SELECT id, entry_number AS number, status, entry_date AS date, NULL::NUMERIC AS total_amount, external_document_number,
               (status IS DISTINCT FROM 'reversed' AND reversed_at IS NULL) AS live
        FROM gl_journal_entries
        WHERE company_id = ${companyId}::UUID AND external_system = ${system} AND external_ref = ${ref}`) as DbRow[];
    case 'bank_transaction':
      return (await sql`
        SELECT id, reference AS number, status, transaction_date AS date, amount AS total_amount, external_document_number,
               TRUE AS live
        FROM bank_transactions
        WHERE company_id = ${companyId}::UUID AND external_system = ${system} AND external_ref = ${ref}`) as DbRow[];
    case 'supplier':
      return (await sql`
        SELECT id, name AS number, NULL::TEXT AS status, NULL::DATE AS date, NULL::NUMERIC AS total_amount, external_document_number,
               (deleted_at IS NULL) AS live
        FROM suppliers
        WHERE company_id = ${companyId}::UUID AND external_system = ${system} AND external_ref = ${ref}`) as DbRow[];
    case 'customer':
      return (await sql`
        SELECT id, name AS number, NULL::TEXT AS status, NULL::DATE AS date, NULL::NUMERIC AS total_amount, external_document_number,
               (deleted_at IS NULL) AS live
        FROM customers
        WHERE company_id = ${companyId}::UUID AND external_system = ${system} AND external_ref = ${ref}`) as DbRow[];
  }
}

/** Every row carrying (system, ref) for this kind, live rows first. */
export async function findByExternalRef(
  companyId: string,
  kind: ExternalRefKind,
  system: string,
  ref: string,
  opts: { creditNoteType?: 'supplier' | 'customer' } = {},
): Promise<ExternalRefMatch[]> {
  const rows = await rowsFor(companyId, kind, system, ref);
  return rows
    .filter((r) => !opts.creditNoteType || r.credit_note_type === opts.creditNoteType)
    .map((r) => ({
      entityType: kind,
      id: String(r.id),
      number: r.number == null ? null : String(r.number),
      status: r.status == null ? null : String(r.status),
      date: isoDate(r.date),
      totalAmount: r.total_amount == null ? null : Number(r.total_amount),
      live: r.live === true,
      externalDocumentNumber: r.external_document_number == null ? null : String(r.external_document_number),
      ...(r.credit_note_type != null ? { creditNoteType: String(r.credit_note_type) } : {}),
    }))
    .sort((a, b) => Number(b.live) - Number(a.live));
}

/** Serialise creates naming the same reference until this transaction ends. */
export async function lockExternalRef(companyId: string, kind: ExternalRefKind, system: string, ref: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`external_ref:${companyId}:${kind}:${system}:${ref}`}, 0))`;
}

/** Record the reference on a row this transaction just created. Throws when the row is not this company's. */
export async function stampExternalRef(companyId: string, kind: ExternalRefKind, id: string, v: ExternalRefValue): Promise<void> {
  const doc = v.documentNumber ?? null;
  let updated: DbRow[];
  switch (kind) {
    case 'supplier_invoice':
      updated = (await sql`UPDATE supplier_invoices SET external_system = ${v.system}, external_ref = ${v.ref}, external_document_number = COALESCE(${doc}, external_document_number)
        WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID RETURNING id`) as DbRow[];
      break;
    case 'customer_invoice':
      updated = (await sql`UPDATE customer_invoices SET external_system = ${v.system}, external_ref = ${v.ref}, external_document_number = COALESCE(${doc}, external_document_number)
        WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID RETURNING id`) as DbRow[];
      break;
    case 'credit_note':
      updated = (await sql`UPDATE credit_notes SET external_system = ${v.system}, external_ref = ${v.ref}, external_document_number = COALESCE(${doc}, external_document_number)
        WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID RETURNING id`) as DbRow[];
      break;
    case 'journal':
      updated = (await sql`UPDATE gl_journal_entries SET external_system = ${v.system}, external_ref = ${v.ref}, external_document_number = COALESCE(${doc}, external_document_number)
        WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID RETURNING id`) as DbRow[];
      break;
    default:
      throw new Error(`stampExternalRef: ${kind} is not stamped by a create tool`);
  }
  if (updated.length !== 1) throw new Error(`stampExternalRef: ${kind} ${id} is not a row of this company`);
}
