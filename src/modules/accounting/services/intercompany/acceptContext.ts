/**
 * What accepting a message needs from the RECEIVER's own books (all of it this company's, under its own RLS): its side of the
 * connection (the supplier the draft goes on, the default expense account and dimensions), the expense account to suggest for
 * each line (the account last used for the same sender description, then the side's default), and whether a bill or note with
 * that number already exists for the supplier. Never reads the sender's books: the payload is all it knows of them.
 */
import { sql } from '@/lib/neon';
import { isHeaderSql } from '../budgets/headerSql';
import type { MirrorLine, MirrorPayload } from './mirrorPayload';
import type { InboxLine } from './inboxTypes';

type Row = Record<string, unknown>;

export interface AcceptSide {
  connectionId: string;
  kind: 'group' | 'external';
  status: string;
  companyLowId: string;
  companyHighId: string;
  supplierId: string | null;
  supplierName: string | null;
  defaultExpenseAccountId: string | null;
  defaultCc1Id: string | null;
  defaultCc2Id: string | null;
  defaultBuId: string | null;
  autoAccept: boolean;
}

/** This company's side of the message's connection, with the connection's state; null when the company has no side there. */
export async function loadAcceptSide(companyId: string, connectionId: string): Promise<AcceptSide | null> {
  const rows = (await sql`
    SELECT c.id, c.kind, c.status, c.company_low_id, c.company_high_id,
           s.supplier_id, su.name AS supplier_name, s.default_expense_account_id, s.default_cc1_id, s.default_cc2_id, s.default_bu_id, s.auto_accept
      FROM intercompany_connections c
      LEFT JOIN intercompany_connection_sides s ON s.connection_id = c.id AND s.company_id = ${companyId}::UUID
      LEFT JOIN suppliers su ON su.id = s.supplier_id AND su.company_id = ${companyId}::UUID AND su.deleted_at IS NULL
     WHERE c.id = ${connectionId}::UUID AND (c.company_low_id = ${companyId}::UUID OR c.company_high_id = ${companyId}::UUID)
  `) as Row[];
  const r = rows[0];
  if (!r) return null;
  const text = (v: unknown): string | null => (v == null ? null : String(v));
  return {
    connectionId: String(r.id), kind: String(r.kind) as AcceptSide['kind'], status: String(r.status),
    companyLowId: String(r.company_low_id), companyHighId: String(r.company_high_id),
    supplierId: r.supplier_name == null ? null : text(r.supplier_id), supplierName: text(r.supplier_name),
    defaultExpenseAccountId: text(r.default_expense_account_id),
    defaultCc1Id: text(r.default_cc1_id), defaultCc2Id: text(r.default_cc2_id), defaultBuId: text(r.default_bu_id),
    autoAccept: r.auto_accept === true,
  };
}

const keyOf = (description: string): string => description.trim().toLowerCase();

async function labelFor(companyId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = (await sql`
    SELECT ga.id, ga.account_code, ga.account_name FROM gl_accounts ga
     WHERE ga.company_id = ${companyId}::UUID AND ga.id = ANY(${ids}::UUID[])
  `) as Row[];
  return new Map(rows.map((r) => [String(r.id), `${String(r.account_code)} ${String(r.account_name)}`.trim()]));
}

/**
 * The expense account per invoice line: the account last used (on this connection's accepted bills, by the sender's line
 * description, case and spacing ignored), else the side's default. A remembered account that is no longer usable (inactive, a
 * header now) is passed over for the default.
 */
export async function resolveLineAccounts(companyId: string, side: AcceptSide, lines: MirrorLine[]): Promise<InboxLine[]> {
  const keys = [...new Set(lines.map((l) => keyOf(l.description)))];
  const last = new Map<string, string>();
  if (keys.length > 0) {
    const rows = (await sql`
      SELECT DISTINCT ON (lower(btrim(sii.description))) lower(btrim(sii.description)) AS k, sii.gl_account_id
        FROM intercompany_messages m
        JOIN supplier_invoices si ON si.id = m.target_doc_id AND si.company_id = ${companyId}::UUID AND si.deleted_at IS NULL
        JOIN supplier_invoice_items sii ON sii.supplier_invoice_id = si.id
        JOIN gl_accounts ga ON ga.id = sii.gl_account_id AND ga.company_id = ${companyId}::UUID AND ga.is_active
                          AND NOT ${isHeaderSql()}
       WHERE m.to_company_id = ${companyId}::UUID AND m.connection_id = ${side.connectionId}::UUID
         AND m.status = 'accepted' AND m.target_doc_type = 'supplier_invoice'
         AND lower(btrim(sii.description)) = ANY(${keys}::TEXT[]) AND sii.gl_account_id IS NOT NULL
       ORDER BY lower(btrim(sii.description)), m.handled_at DESC NULLS LAST, sii.created_at DESC
    `) as Row[];
    for (const r of rows) last.set(String(r.k), String(r.gl_account_id));
  }
  const defaultOk = side.defaultExpenseAccountId ? await usable(companyId, side.defaultExpenseAccountId) : false;
  const picked = lines.map((l) => {
    const remembered = last.get(keyOf(l.description));
    return remembered
      ? { id: remembered, source: 'last_used' as const }
      : defaultOk && side.defaultExpenseAccountId ? { id: side.defaultExpenseAccountId, source: 'default' as const } : { id: null, source: null };
  });
  const labels = await labelFor(companyId, [...new Set(picked.map((p) => p.id).filter((x): x is string => x !== null))]);
  return lines.map((l, index) => ({
    index, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate,
    taxAmount: l.taxAmount, lineTotal: l.lineTotal,
    accountId: picked[index]!.id, accountLabel: picked[index]!.id ? labels.get(picked[index]!.id!) ?? null : null, accountSource: picked[index]!.source,
  }));
}

async function usable(companyId: string, accountId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM gl_accounts ga
     WHERE ga.id = ${accountId}::UUID AND ga.company_id = ${companyId}::UUID AND ga.is_active AND NOT ${isHeaderSql()}
  `) as Row[];
  return rows.length > 0;
}

/** True when every id is one of this company's active, non-header accounts. */
export async function accountsUsable(companyId: string, ids: string[]): Promise<boolean> {
  const distinct = [...new Set(ids)];
  const rows = (await sql`
    SELECT count(*)::int AS n FROM gl_accounts ga
     WHERE ga.company_id = ${companyId}::UUID AND ga.id = ANY(${distinct}::UUID[]) AND ga.is_active AND NOT ${isHeaderSql()}
  `) as Row[];
  return Number(rows[0]?.n ?? 0) === distinct.length;
}

/** The account a credit note credits: the one the last accepted note on this connection used, else the side's default. */
export async function resolveCreditNoteAccount(companyId: string, side: AcceptSide): Promise<{ id: string | null; label: string | null; source: 'last_used' | 'default' | null }> {
  const rows = (await sql`
    SELECT cn.gl_account_id
      FROM intercompany_messages m
      JOIN credit_notes cn ON cn.id = m.target_doc_id AND cn.company_id = ${companyId}::UUID AND cn.type = 'supplier'
      JOIN gl_accounts ga ON ga.id = cn.gl_account_id AND ga.company_id = ${companyId}::UUID AND ga.is_active AND NOT ${isHeaderSql()}
     WHERE m.to_company_id = ${companyId}::UUID AND m.connection_id = ${side.connectionId}::UUID
       AND m.status = 'accepted' AND m.target_doc_type = 'credit_note' AND cn.gl_account_id IS NOT NULL
     ORDER BY m.handled_at DESC NULLS LAST LIMIT 1
  `) as Row[];
  const remembered = rows[0] ? String(rows[0].gl_account_id) : null;
  const id = remembered ?? (side.defaultExpenseAccountId && await usable(companyId, side.defaultExpenseAccountId) ? side.defaultExpenseAccountId : null);
  const label = id ? (await labelFor(companyId, [id])).get(id) ?? null : null;
  return { id, label, source: remembered ? 'last_used' : id ? 'default' : null };
}

/**
 * An existing bill (or supplier credit note) that would make the draft a duplicate. A bill: this supplier's bill with the payload's
 * number. A credit note: it has no number of the sender's of its own (this company numbers it), so it is the note an earlier ACCEPTED
 * message from the same sender with the same number created, if that note still exists and is not cancelled. That reads the message
 * (immutable payload) and the note's existence, never an editable text field.
 */
export async function findDuplicate(companyId: string, side: AcceptSide, payload: MirrorPayload, fromCompanyId: string): Promise<{ id: string; number: string } | null> {
  if (!side.supplierId) return null;
  if (payload.kind === 'invoice') {
    const rows = (await sql`
      SELECT id, invoice_number FROM supplier_invoices
       WHERE company_id = ${companyId}::UUID AND supplier_id = ${side.supplierId}::UUID AND deleted_at IS NULL
         AND invoice_number = ${payload.number}
       LIMIT 1
    `) as Row[];
    return rows[0] ? { id: String(rows[0].id), number: String(rows[0].invoice_number) } : null;
  }
  const rows = (await sql`
    SELECT cn.id FROM intercompany_messages m
      JOIN credit_notes cn ON cn.id = m.target_doc_id AND cn.company_id = ${companyId}::UUID AND cn.type = 'supplier' AND cn.status <> 'cancelled'
     WHERE m.to_company_id = ${companyId}::UUID AND m.from_company_id = ${fromCompanyId}::UUID AND m.kind = 'credit_note'
       AND m.status = 'accepted' AND m.target_doc_type = 'credit_note' AND m.payload->>'number' = ${payload.number}
     LIMIT 1
  `) as Row[];
  return rows[0] ? { id: String(rows[0].id), number: payload.number } : null;
}

/** The accounts the Accept dialog offers: this company's postable accounts, bounded. */
export async function accountOptions(companyId: string): Promise<Array<{ id: string; label: string }>> {
  const rows = (await sql`
    SELECT ga.id, ga.account_code, ga.account_name FROM gl_accounts ga
     WHERE ga.company_id = ${companyId}::UUID AND ga.is_active AND NOT ${isHeaderSql()}
       AND ga.account_type IN ('expense', 'asset')
     ORDER BY ga.account_code LIMIT 500
  `) as Row[];
  return rows.map((r) => ({ id: String(r.id), label: `${String(r.account_code)} ${String(r.account_name)}`.trim() }));
}
