/**
 * Reads for the pairing screen. This company's own documents and links come from its own tables, under the request's RLS (a company
 * never reads another's). The partner's side comes only through the two definer functions of migration 1012, which hand over number,
 * date, total and open amount of the partner's open pre-cut-over documents of the party it linked, and one loan-balance figure.
 * An "open" document is the ageing's: not a draft, pending approval or cancelled, not deleted, total above amount paid.
 */
import { sql } from '@/lib/neon';
import { toIsoTimestamp } from '@/lib/dateUtils';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import type { PairingDirection, PairingDoc, PairingDocType } from './pairingTypes';

type Row = Record<string, unknown>;

/** The most documents either side offers at once: a longer list is cut and the screen says so. */
export const DOC_LIMIT = 2000;

export const MY_TYPE: Record<PairingDirection, PairingDocType> = { ar: 'customer_invoice', ap: 'supplier_invoice' };
export const THEIR_TYPE: Record<PairingDirection, PairingDocType> = { ar: 'supplier_invoice', ap: 'customer_invoice' };

const toDoc = (r: Row): PairingDoc => ({
  id: String(r.id), number: String(r.number ?? ''), date: String(r.date ?? ''),
  total: Number(r.total), open: Number(r.open), currency: String(r.currency ?? 'ZAR'),
});

/** One of this company's open pre-cut-over documents of `partyId` (the customer or supplier linked on the connection). */
export async function readOwnOpenDocs(direction: PairingDirection, companyId: string, partyId: string, cutover: string): Promise<PairingDoc[]> {
  const rows = (direction === 'ar' ? await sql`
    SELECT ci.id, ci.invoice_number AS number, to_char(ci.invoice_date, 'YYYY-MM-DD') AS date, ci.total_amount::float8 AS total,
           (ci.total_amount - COALESCE(ci.amount_paid, 0))::float8 AS open, ci.currency_code AS currency
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}::UUID AND COALESCE(ci.client_id, ci.customer_id) = ${partyId}::UUID
      AND COALESCE(ci.status, '') NOT IN ('draft', 'pending_approval', 'cancelled') AND ci.deleted_at IS NULL
      AND ci.invoice_date < ${cutover}::DATE AND ci.total_amount - COALESCE(ci.amount_paid, 0) > 0
    ORDER BY ci.invoice_date, ci.invoice_number, ci.id
    LIMIT ${DOC_LIMIT + 1}
  ` : await sql`
    SELECT si.id, si.invoice_number AS number, to_char(si.invoice_date, 'YYYY-MM-DD') AS date, si.total_amount::float8 AS total,
           (si.total_amount - COALESCE(si.amount_paid, 0))::float8 AS open, si.currency_code AS currency
    FROM supplier_invoices si
    WHERE si.company_id = ${companyId}::UUID AND si.supplier_id = ${partyId}::UUID
      AND COALESCE(si.status, '') NOT IN ('draft', 'pending_approval', 'cancelled') AND si.deleted_at IS NULL
      AND si.invoice_date < ${cutover}::DATE AND si.total_amount - COALESCE(si.amount_paid, 0) > 0
    ORDER BY si.invoice_date, si.invoice_number, si.id
    LIMIT ${DOC_LIMIT + 1}
  `) as Row[];
  return rows.map(toDoc);
}

/** This company's documents by id (a pairing's own side), settled or not: the pairing outlives the document's openness. */
export async function readOwnDocsById(direction: PairingDirection, companyId: string, ids: string[]): Promise<Map<string, PairingDoc>> {
  if (ids.length === 0) return new Map();
  const rows = (direction === 'ar' ? await sql`
    SELECT ci.id, ci.invoice_number AS number, to_char(ci.invoice_date, 'YYYY-MM-DD') AS date, ci.total_amount::float8 AS total,
           (ci.total_amount - COALESCE(ci.amount_paid, 0))::float8 AS open, ci.currency_code AS currency
    FROM customer_invoices ci WHERE ci.company_id = ${companyId}::UUID AND ci.id = ANY(${ids}::UUID[])
  ` : await sql`
    SELECT si.id, si.invoice_number AS number, to_char(si.invoice_date, 'YYYY-MM-DD') AS date, si.total_amount::float8 AS total,
           (si.total_amount - COALESCE(si.amount_paid, 0))::float8 AS open, si.currency_code AS currency
    FROM supplier_invoices si WHERE si.company_id = ${companyId}::UUID AND si.id = ANY(${ids}::UUID[])
  `) as Row[];
  return new Map(rows.map((r) => [String(r.id), toDoc(r)]));
}

export interface PartnerDoc extends PairingDoc {
  /** The link of THIS connection that holds the document, or null. */
  linkId: string | null;
}

/** The partner's open pre-cut-over documents of the party it linked (definer, migration 1012): empty unless the caller may ask. */
export async function readPartnerDocs(connectionId: string, direction: PairingDirection): Promise<PartnerDoc[]> {
  const rows = (await sql`
    SELECT doc_id AS id, doc_number AS number, to_char(doc_date, 'YYYY-MM-DD') AS date, total_amount::float8 AS total,
           open_amount::float8 AS open, currency_code AS currency, link_id
    FROM public.intercompany_pairing_partner_documents(${connectionId}::UUID, ${THEIR_TYPE[direction]})
    ORDER BY doc_date, doc_number, doc_id
    LIMIT ${DOC_LIMIT + 1}
  `) as Row[];
  return rows.map((r) => ({ ...toDoc(r), linkId: r.link_id == null ? null : String(r.link_id) }));
}

/**
 * This company's net debit on its loan account (debits less credits of posted journals dated before the cut-over, the year-end
 * closing journal left out as every figure does: G-01), to the cent.
 */
export async function readOwnLoanBalance(companyId: string, accountId: string, cutover: string): Promise<number> {
  const rows = (await sql`
    SELECT ROUND(COALESCE(SUM(jl.debit - jl.credit), 0), 2)::float8 AS balance
    FROM gl_journal_entries je
    JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID
    WHERE je.company_id = ${companyId}::UUID AND je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
      AND je.entry_date < ${cutover}::DATE AND jl.gl_account_id = ${accountId}::UUID
  `) as Row[];
  return Number(rows[0]?.balance ?? 0);
}

/** The partner's loan balance the same way (definer); null when it is not available to this caller or the partner set no account. */
export async function readPartnerLoanBalance(connectionId: string): Promise<number | null> {
  const rows = (await sql`
    SELECT ROUND(public.intercompany_pairing_partner_loan_balance(${connectionId}::UUID), 2)::float8 AS balance
  `) as Row[];
  const value = rows[0]?.balance;
  return value == null ? null : Number(value);
}

/** A document link of this company, as stored. */
export interface LinkRow {
  id: string;
  connectionId: string;
  status: 'pending_confirmation' | 'active';
  /** This company is the connection's low company (position A). */
  mineIsA: boolean;
  docAType: PairingDocType;
  docAId: string;
  docBType: PairingDocType;
  docBId: string;
  /** 'manual_pairing' (this screen) or 'mirror' (made by an accepted message: not this screen's to confirm or unlink). */
  origin: 'manual_pairing' | 'mirror';
  confirmedByMe: boolean;
  confirmedByPartner: boolean;
  createdAt: string;
}

/** Every live (not unlinked) link this company is a party to, on any connection: RLS limits the rows to its own. */
export async function readOwnLinks(companyId: string): Promise<LinkRow[]> {
  const rows = (await sql`
    SELECT l.id, l.connection_id, l.status, (l.company_a_id = ${companyId}::UUID) AS mine_is_a,
           l.doc_a_type, l.doc_a_id, l.doc_b_type, l.doc_b_id, l.origin, l.confirmed_by_a, l.confirmed_by_b, l.created_at
    FROM intercompany_document_links l
    WHERE l.status <> 'unlinked' AND (l.company_a_id = ${companyId}::UUID OR l.company_b_id = ${companyId}::UUID)
    ORDER BY l.created_at DESC, l.id
  `) as Row[];
  return rows.map((r) => {
    const mineIsA = r.mine_is_a === true;
    return {
      id: String(r.id), connectionId: String(r.connection_id), status: String(r.status) as LinkRow['status'], mineIsA,
      docAType: String(r.doc_a_type) as PairingDocType, docAId: String(r.doc_a_id),
      docBType: String(r.doc_b_type) as PairingDocType, docBId: String(r.doc_b_id), origin: r.origin === 'mirror' ? 'mirror' : 'manual_pairing',
      confirmedByMe: (mineIsA ? r.confirmed_by_a : r.confirmed_by_b) != null,
      confirmedByPartner: (mineIsA ? r.confirmed_by_b : r.confirmed_by_a) != null,
      createdAt: toIsoTimestamp(r.created_at as Date | string) ?? '',
    };
  });
}

export const myDocId = (l: LinkRow): string => (l.mineIsA ? l.docAId : l.docBId);
export const myDocType = (l: LinkRow): PairingDocType => (l.mineIsA ? l.docAType : l.docBType);
/** A pairing this screen manages: a manual pairing of an invoice with a bill (not a mirror link, not a credit-note link). */
export const isInvoicePairing = (l: LinkRow): boolean =>
  l.origin === 'manual_pairing' && new Set<PairingDocType>([l.docAType, l.docBType]).size === 2
  && [l.docAType, l.docBType].every((t) => t === 'customer_invoice' || t === 'supplier_invoice');
export const theirDocId = (l: LinkRow): string => (l.mineIsA ? l.docBId : l.docAId);
