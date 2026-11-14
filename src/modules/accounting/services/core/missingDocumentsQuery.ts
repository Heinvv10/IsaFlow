/**
 * The SQL half of list_missing_documents: one UNION ALL of candidate rows per entity type, each carrying a COMPUTED
 * `has_doc` (core/documentPresenceSql for bills, invoices and credit notes; bank/bankLineDocumentSql for bank lines),
 * then a per-type summary and a keyset page of the rows with no document.
 *
 * Population rules, per type (all scoped by company_id on the entity's own table):
 *  - supplier_invoice / customer_invoice: not draft, not cancelled, not soft-deleted; dated in range.
 *  - credit_note: not draft, not cancelled; credit_date in range.
 *  - bank_transaction: SPEND only (amount < 0), a posted feed line, not excluded, not an own-account transfer.
 * The cutoff is on ABS(amount) >= min. Order: cents DESC, entity type, id — a total order, so a keyset cursor is exact.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { hasBankLineDocumentSql, hasEntityDocumentSql } from './documentPresenceSql';
import type {
  MissingDocumentFilters, MissingDocumentKey, MissingDocumentRow, MissingDocumentSummary,
  MissingDocumentType, SqlMissingDocumentType,
} from './missingDocumentsTypes';

/** Named once on the CTE, so any one arm can stand alone (the arms alias nothing but the first). */
// A function, not a constant: tests that mock '@/lib/neon' without `unsafe` still import this module.
const candColumns = () => sql.unsafe('entity_type, entity_id, doc_date, amount, reference, counterparty, description, status, has_doc');

type Window = Pick<MissingDocumentFilters, 'companyId' | 'from' | 'to' | 'minAmount'>;

const ARMS: Record<SqlMissingDocumentType, (w: Window) => ReturnType<typeof sql>> = {
  supplier_invoice: (w) => sql`
    SELECT 'supplier_invoice'::text AS entity_type, si.id AS entity_id, si.invoice_date AS doc_date,
           ABS(si.total_amount)::numeric AS amount, si.invoice_number::text AS reference, s.name::text AS counterparty,
           si.reference::text AS description, si.status::text AS status,
           ${sql.unsafe(hasEntityDocumentSql('supplier_invoice', 'si'))} AS has_doc
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = si.company_id
     WHERE si.company_id = ${w.companyId}::UUID AND si.deleted_at IS NULL AND si.status NOT IN ('draft', 'cancelled')
       AND si.invoice_date >= ${w.from}::DATE AND si.invoice_date <= ${w.to}::DATE
       AND ABS(si.total_amount) >= ${w.minAmount}::numeric`,
  customer_invoice: (w) => sql`
    SELECT 'customer_invoice'::text, ci.id, ci.invoice_date, ABS(ci.total_amount)::numeric, ci.invoice_number::text,
           c.name::text, NULL::text, ci.status::text,
           ${sql.unsafe(hasEntityDocumentSql('customer_invoice', 'ci'))}
      FROM customer_invoices ci
      LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id) AND c.company_id = ci.company_id
     WHERE ci.company_id = ${w.companyId}::UUID AND ci.deleted_at IS NULL AND ci.status NOT IN ('draft', 'cancelled')
       AND ci.invoice_date >= ${w.from}::DATE AND ci.invoice_date <= ${w.to}::DATE
       AND ABS(ci.total_amount) >= ${w.minAmount}::numeric`,
  credit_note: (w) => sql`
    SELECT 'credit_note'::text, cn.id, cn.credit_date, ABS(cn.total_amount)::numeric, cn.credit_note_number::text,
           COALESCE(c.name, s.name)::text, cn.reason::text, cn.status::text,
           ${sql.unsafe(hasEntityDocumentSql('credit_note', 'cn'))}
      FROM credit_notes cn
      LEFT JOIN customers c ON c.id = cn.client_id AND c.company_id = cn.company_id
      LEFT JOIN suppliers s ON s.id = cn.supplier_id AND s.company_id = cn.company_id
     WHERE cn.company_id = ${w.companyId}::UUID AND cn.status NOT IN ('draft', 'cancelled')
       AND cn.credit_date >= ${w.from}::DATE AND cn.credit_date <= ${w.to}::DATE
       AND ABS(cn.total_amount) >= ${w.minAmount}::numeric`,
  bank_transaction: (w) => sql`
    SELECT 'bank_transaction'::text, bt.id, bt.transaction_date, ABS(bt.amount)::numeric,
           COALESCE(bt.reference, bt.bank_reference)::text, bt.allocated_entity_name::text, bt.description::text,
           bt.status::text, ${sql.unsafe(hasBankLineDocumentSql('bt'))}
      FROM bank_transactions bt
     WHERE bt.company_id = ${w.companyId}::UUID AND bt.amount < 0 AND bt.feed_state = 'posted'
       AND bt.status <> 'excluded' AND bt.transfer_journal_entry_id IS NULL
       AND bt.allocation_type IS DISTINCT FROM 'transfer'
       AND bt.transaction_date >= ${w.from}::DATE AND bt.transaction_date <= ${w.to}::DATE
       AND ABS(bt.amount) >= ${w.minAmount}::numeric`,
};

/** Union of the arms for `types` (vat_journal is not SQL), or null when none is asked for. */
function candidates(f: Window & { types: readonly MissingDocumentType[] }): ReturnType<typeof sql> | null {
  const arms = (Object.keys(ARMS) as SqlMissingDocumentType[]).filter((t) => f.types.includes(t)).map((t) => ARMS[t](f));
  if (arms.length === 0) return null;
  return arms.reduce((acc, arm) => sql`${acc} UNION ALL ${arm}`);
}

export async function summariseSqlTypes(f: MissingDocumentFilters): Promise<MissingDocumentSummary[]> {
  const cand = candidates(f);
  if (!cand) return [];
  const rows = (await sql`
    WITH cand(${candColumns()}) AS (${cand})
    SELECT entity_type, COUNT(*)::int AS candidates, COUNT(*) FILTER (WHERE NOT has_doc)::int AS missing,
           COALESCE(SUM(amount) FILTER (WHERE NOT has_doc), 0)::numeric AS missing_amount
      FROM cand GROUP BY entity_type
  `) as DbRow[];
  return rows.map((r) => ({
    entityType: r.entity_type as MissingDocumentType,
    candidates: Number(r.candidates),
    withDocument: Number(r.candidates) - Number(r.missing),
    missing: Number(r.missing),
    missingAmount: Number(r.missing_amount),
  }));
}

/** The first `limit` missing rows after `after` in key order (the caller asks for one extra to learn whether more follow). */
export async function pageSqlTypes(f: MissingDocumentFilters, limit: number): Promise<MissingDocumentRow[]> {
  const cand = candidates(f);
  if (!cand) return [];
  const a: MissingDocumentKey | null = f.after;
  const keyset = a === null ? sql.unsafe('TRUE') : sql`(
    m.cents < ${a.cents}::bigint
    OR (m.cents = ${a.cents}::bigint AND (m.entity_type COLLATE "C" > ${a.entityType}::text
      OR (m.entity_type COLLATE "C" = ${a.entityType}::text AND m.entity_id::text COLLATE "C" > ${a.id}::text))))`;
  const rows = (await sql`
    WITH cand(${candColumns()}) AS (${cand})
    SELECT m.* FROM (
      SELECT cand.*, ROUND(cand.amount * 100)::bigint AS cents FROM cand WHERE NOT cand.has_doc
    ) m
    WHERE ${keyset}
    ORDER BY m.cents DESC, m.entity_type COLLATE "C", m.entity_id::text COLLATE "C"
    LIMIT ${limit}
  `) as DbRow[];
  return rows.map((r) => ({
    entityType: r.entity_type as MissingDocumentType,
    entityId: String(r.entity_id),
    documentDate: fmtDate(r.doc_date),
    amount: Number(r.amount),
    cents: Number(r.cents),
    reference: r.reference == null ? null : String(r.reference),
    counterparty: r.counterparty == null ? null : String(r.counterparty),
    description: r.description == null ? null : String(r.description),
    status: r.status == null ? null : String(r.status),
    reason: null,
  }));
}
