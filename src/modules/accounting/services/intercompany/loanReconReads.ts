/**
 * The loan reconciliation's reads (P5, plan sections (b6), (f)). Read only: no write, no row or advisory lock, no lock_timeout change.
 *
 * ONE statement answers a report: b4 (`intercompany_loan_recon_summary`) once, b3 (`intercompany_loan_recon_messages`) once, this company's
 * own message rows and documents, its unsent payments and unlinked partner bills, the pair's cut-over and `statement_timestamp()`. withAuth's
 * transaction is READ COMMITTED and already started, so REPEATABLE READ cannot be set; but a STABLE function runs on its calling statement's
 * snapshot, so the partner's figures, the message states and the own rows are all as of the same instant (migration 1030 halts if b0-b4 or a
 * callee is not STABLE). Every app-side read runs as app_user under RLS and names company_id = S; `payment_allocations` has no RLS and no
 * company_id, so its tenant scope is ONLY the INNER join to `supplier_payments` (company_id = S). The `unsent` and `unlinked` lists are cut
 * at MAX_RECON_LIST_ROWS (oldest first) and read one row more, so the service can say a list was cut; `unsent` is read only on a connection
 * whose settlement mode is loan (the sender sends nothing on a cash one: 1025 `not_loan`).
 */
import { sql } from '@/lib/neon';
import { MAX_RECON_LIST_ROWS, RECON_STATEMENT_TIMEOUT_MS } from './loanReconTypes';

type Row = Record<string, unknown>;

/** S's connections the report may open: a loan connection, or one carrying an allocation message S can read. */
export async function readReconConnections(companyId: string, connectionId?: string): Promise<Row[]> {
  return (await sql`
    SELECT c.id::TEXT AS id, c.status, c.settlement_mode, pc.name AS partner_name
      FROM intercompany_connections c
      LEFT JOIN companies pc ON pc.id = CASE WHEN c.company_low_id = ${companyId}::UUID THEN c.company_high_id ELSE c.company_low_id END
     WHERE (c.company_low_id = ${companyId}::UUID OR c.company_high_id = ${companyId}::UUID)
       AND (${connectionId ?? null}::UUID IS NULL OR c.id = ${connectionId ?? null}::UUID)
       AND (c.settlement_mode = 'loan' OR EXISTS (
             SELECT 1 FROM intercompany_messages m
              WHERE m.connection_id = c.id AND m.kind = 'allocation' AND m.source_doc_type = 'payment_allocation'
                AND (m.from_company_id = ${companyId}::UUID OR m.to_company_id = ${companyId}::UUID)))
     ORDER BY (c.status <> 'active'), c.created_at DESC, c.id
  `) as Row[];
}

/** How many allocation messages of the connection S reads (the 5 000 cap is judged before the report runs). */
export async function countReconMessages(companyId: string, connectionId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::INT AS n FROM intercompany_messages m
     WHERE m.connection_id = ${connectionId}::UUID AND m.kind = 'allocation' AND m.source_doc_type = 'payment_allocation'
       AND (m.from_company_id = ${companyId}::UUID OR m.to_company_id = ${companyId}::UUID)
  `) as Row[];
  return Number(rows[0]?.n ?? 0);
}

/** Tighten-only statement bound (the budgetAlertCron / sliceReminders inline pattern); answers the caller's value to put back. */
export async function boundStatement(): Promise<string> {
  const prev = String(((await sql`SELECT pg_catalog.current_setting('statement_timeout') AS v`) as Row[])[0]?.v ?? '0');
  await sql`
    SELECT pg_catalog.set_config('statement_timeout', ${String(RECON_STATEMENT_TIMEOUT_MS)}::TEXT, true) FROM pg_catalog.pg_settings
     WHERE name = 'statement_timeout' AND (setting::BIGINT = 0 OR setting::BIGINT > ${RECON_STATEMENT_TIMEOUT_MS}::BIGINT)
  `;
  return prev;
}

export async function restoreStatement(prev: string): Promise<void> {
  await sql`SELECT pg_catalog.set_config('statement_timeout', ${prev}, true)`;
}

/** The ONE statement of a report. */
export async function readReconStatement(companyId: string, connectionId: string): Promise<Row | undefined> {
  const rows = (await sql`
    WITH s AS MATERIALIZED (SELECT * FROM public.intercompany_loan_recon_summary(${connectionId}::UUID)),
    b AS MATERIALIZED (SELECT * FROM public.intercompany_loan_recon_messages(${connectionId}::UUID)),
    conn AS MATERIALIZED (
      SELECT c.company_low_id, c.company_high_id FROM intercompany_connections c
       WHERE c.id = ${connectionId}::UUID AND (c.company_low_id = ${companyId}::UUID OR c.company_high_id = ${companyId}::UUID)
    ),
    cut AS MATERIALIZED (
      SELECT pc.cutover
        FROM company_group_members gm
       CROSS JOIN LATERAL public.intercompany_pair_cutovers(gm.group_id) pc
        JOIN conn ON pc.company_low_id = conn.company_low_id AND pc.company_high_id = conn.company_high_id
       WHERE gm.company_id = ${companyId}::UUID AND gm.left_date IS NULL
       -- intercompany_pair_cutovers answers a pair only in the group its mirrors go to, so at most one row; ordered all the same (round 1, LOW-6)
       ORDER BY pc.cutover, gm.group_id
       LIMIT 1
    ),
    msg AS (
      SELECT b.*, m.status, m.created_at, m.error, (m.source_cancelled_at IS NOT NULL) AS source_cancelled,
             EXTRACT(EPOCH FROM (pg_catalog.statement_timestamp() - m.created_at)) / 86400 AS age_days,
             CASE WHEN jsonb_typeof(m.payload -> 'amount') = 'number' THEN round((m.payload ->> 'amount')::NUMERIC, 2) END AS amount,
             m.payload #>> '{payment,number}' AS d_payment_number, m.payload #>> '{payment,date}' AS d_payment_date,
             m.payload #>> '{payment,reference}' AS d_reference, m.payload #>> '{payerDocument,number}' AS d_payer_document,
             m.payload ->> 'currency' AS d_currency,
             bill.id AS bill_id, bill.invoice_number AS bill_number, sp.id AS payment_id, sp.payment_number, sp.status AS payment_status,
             inv.id AS invoice_id, inv.invoice_number, rcp.id AS receipt_id, rcp.payment_number AS receipt_number
        FROM b
        JOIN intercompany_messages m ON m.id = b.message_id
        -- this company's OWN documents only, each under company_id = S (a payload id naming another company's row finds nothing)
        LEFT JOIN supplier_invoices bill ON b.direction = 'out' AND bill.company_id = ${companyId}::UUID
             AND bill.id = CASE WHEN (m.payload #>> '{payerDocument,id}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                THEN (m.payload #>> '{payerDocument,id}')::UUID END
        LEFT JOIN supplier_payments sp ON b.direction = 'out' AND sp.company_id = ${companyId}::UUID
             AND sp.id = CASE WHEN (m.payload #>> '{payment,id}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                              THEN (m.payload #>> '{payment,id}')::UUID END
        LEFT JOIN customer_invoices inv ON b.direction = 'in' AND inv.company_id = ${companyId}::UUID
             AND inv.id = CASE WHEN (m.payload #>> '{issuerDocument,id}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                               THEN (m.payload #>> '{issuerDocument,id}')::UUID END
        LEFT JOIN customer_payments rcp ON b.direction = 'in' AND rcp.company_id = ${companyId}::UUID
             AND m.target_doc_type = 'customer_payment' AND rcp.id = m.target_doc_id
    ),
    unsent AS (
      SELECT a.id AS allocation_id, a.amount_allocated AS amount, a.created_at, p.id AS payment_id, p.payment_number, p.payment_date,
             p.status AS payment_status, p.reference, bl.id AS bill_id, bl.invoice_number AS bill_number
        FROM payment_allocations a
        -- the ONLY tenant scope of payment_allocations (no RLS, no company_id): this INNER join to S's own payments
        JOIN supplier_payments p ON p.id = a.payment_id AND p.company_id = ${companyId}::UUID AND p.status IN ('processed', 'reconciled')
        JOIN supplier_invoices bl ON bl.id = a.invoice_id AND bl.company_id = ${companyId}::UUID AND bl.deleted_at IS NULL
        JOIN intercompany_document_links l ON l.connection_id = ${connectionId}::UUID AND l.status = 'active'
             AND ((l.company_a_id = ${companyId}::UUID AND l.doc_a_type = 'supplier_invoice' AND l.doc_a_id = bl.id AND l.doc_b_type = 'customer_invoice')
               OR (l.company_b_id = ${companyId}::UUID AND l.doc_b_type = 'supplier_invoice' AND l.doc_b_id = bl.id AND l.doc_a_type = 'customer_invoice'))
        LEFT JOIN intercompany_messages om ON om.from_company_id = ${companyId}::UUID AND om.kind = 'allocation'
             AND om.source_doc_type = 'payment_allocation' AND om.source_doc_id = a.id
       WHERE om.id IS NULL
         -- the sender sends allocation messages only on a loan connection (1025 not_loan): on a cash one no payment is "unsent" (round 1, (h))
         AND EXISTS (SELECT 1 FROM intercompany_connections c WHERE c.id = ${connectionId}::UUID AND c.settlement_mode = 'loan'
                        AND (c.company_low_id = ${companyId}::UUID OR c.company_high_id = ${companyId}::UUID))
       ORDER BY a.created_at, a.id
       LIMIT ${MAX_RECON_LIST_ROWS + 1}
    ),
    unlinked AS (
      SELECT bl.id AS bill_id, bl.invoice_number AS bill_number, bl.invoice_date AS bill_date, bl.amount_paid, bl.created_at
        FROM supplier_invoices bl
        JOIN intercompany_connection_sides sd ON sd.connection_id = ${connectionId}::UUID AND sd.company_id = ${companyId}::UUID AND bl.supplier_id = sd.supplier_id
        JOIN cut ON bl.invoice_date >= cut.cutover
       WHERE bl.company_id = ${companyId}::UUID AND bl.amount_paid > 0 AND bl.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM intercompany_document_links l
            WHERE l.connection_id = ${connectionId}::UUID AND l.status <> 'unlinked'
              AND ((l.company_a_id = ${companyId}::UUID AND l.doc_a_type = 'supplier_invoice' AND l.doc_a_id = bl.id)
                OR (l.company_b_id = ${companyId}::UUID AND l.doc_b_type = 'supplier_invoice' AND l.doc_b_id = bl.id)))
       ORDER BY bl.created_at, bl.id
       LIMIT ${MAX_RECON_LIST_ROWS + 1}
    )
    SELECT (SELECT row_to_json(s) FROM s LIMIT 1) AS summary,
           (SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.created_at, x.message_id), '[]'::JSON) FROM msg x) AS messages,
           (SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.created_at, x.allocation_id), '[]'::JSON) FROM unsent x) AS unsent,
           (SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.created_at, x.bill_id), '[]'::JSON) FROM unlinked x) AS unlinked,
           (SELECT to_char(cut.cutover, 'YYYY-MM-DD') FROM cut) AS cutover,
           pg_catalog.statement_timestamp() AS read_at
  `) as Row[];
  return rows[0];
}
