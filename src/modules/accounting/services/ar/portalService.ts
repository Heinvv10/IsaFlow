/**
 * Client Portal Service
 * Customer-facing self-service: view invoices, download statements, payment links.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import bcrypt from 'bcryptjs';
import type { DbRow } from '@/types/db';
import { asAtTodayStr, documentInLedgerAsAtFragment } from '../shared/softDeleteLedgerPresence';


// ── Types ────────────────────────────────────────────────────────────────────

export interface PortalUser {
  id: string;
  clientId: string;
  companyId: string;
  email: string;
  name: string;
  isActive: boolean;
  lastLoginAt: string | null;
}

export interface PortalInvoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  total: number;
  amountPaid: number;
  balance: number;
  status: string;
}

export interface PortalStatement {
  clientName: string;
  clientEmail: string;
  asOfDate: string;
  openingBalance: number;
  transactions: Array<{
    date: string;
    reference: string;
    description: string;
    debit: number;
    credit: number;
    balance: number;
  }>;
  closingBalance: number;
}

// ── Portal Auth ──────────────────────────────────────────────────────────────

export async function createPortalUser(input: {
  clientId: string;
  email: string;
  password: string;
  name: string;
}): Promise<PortalUser> {
  const hash = await bcrypt.hash(input.password, 12);
  const rows = (await sql`
    INSERT INTO portal_access (client_id, email, password_hash, name)
    VALUES (${input.clientId}::UUID, ${input.email}, ${hash}, ${input.name})
    RETURNING *
  `) as DbRow[];
  log.info('Portal user created', { email: input.email }, 'portal');
  return mapPortalUser(rows[0]!);
}

export async function authenticatePortalUser(email: string, password: string): Promise<PortalUser | null> {
  // Join customers to bind the portal session to a specific company — pentest H2
  // fixed the missing company_id scope in downstream queries; the token now
  // carries companyId so it's verified against a single tenant.
  const rows = (await sql`
    SELECT pa.*, c.company_id AS customer_company_id
    FROM portal_access pa
    JOIN customers c ON c.id = pa.client_id
    WHERE pa.email = ${email} AND pa.is_active = true
  `) as DbRow[];
  if (!rows[0]) return null;

  const valid = await bcrypt.compare(password, String(rows[0].password_hash));
  if (!valid) return null;

  await sql`UPDATE portal_access SET last_login_at = NOW() WHERE id = ${String(rows[0].id)}::UUID`;
  return mapPortalUser(rows[0]);
}

export async function listPortalUsers(clientId?: string): Promise<PortalUser[]> {
  const rows = clientId
    ? (await sql`
        SELECT pa.*, c.company_id AS customer_company_id
        FROM portal_access pa
        JOIN customers c ON c.id = pa.client_id
        WHERE pa.client_id = ${clientId}::UUID
        ORDER BY pa.name
      `) as DbRow[]
    : (await sql`
        SELECT pa.*, c.company_id AS customer_company_id
        FROM portal_access pa
        JOIN customers c ON c.id = pa.client_id
        ORDER BY pa.name
      `) as DbRow[];
  return rows.map(mapPortalUser);
}

// ── Portal Data ──────────────────────────────────────────────────────────────

export async function getClientInvoices(clientId: string, companyId: string): Promise<PortalInvoice[]> {
  // COALESCE(client_id, customer_id) — both columns historically exist (see CLAUDE.md).
  const rows = (await sql`
    SELECT id, invoice_number, invoice_date, due_date, total,
           COALESCE(amount_paid, 0) AS amount_paid,
           (total - COALESCE(amount_paid, 0)) AS balance,
           status
    FROM customer_invoices ci
    WHERE COALESCE(ci.client_id, ci.customer_id) = ${clientId}::UUID
      AND ci.company_id = ${companyId}::UUID
        -- K-053: a soft-deleted invoice leaves this list exactly when the
        -- delete's GL reversal reaches the ledger, and not one day earlier.
        -- See shared/softDeleteLedgerPresence.
      AND ${documentInLedgerAsAtFragment('ci', asAtTodayStr(), companyId)}
      AND ci.status NOT IN ('draft', 'cancelled')
    ORDER BY ci.invoice_date DESC
  `) as DbRow[];

  return rows.map((r: DbRow) => ({
    id: String(r.id),
    invoiceNumber: String(r.invoice_number),
    invoiceDate: String(r.invoice_date),
    dueDate: String(r.due_date),
    total: Number(r.total),
    amountPaid: Number(r.amount_paid),
    balance: Number(r.balance),
    status: String(r.status),
  }));
}

export async function getClientStatement(clientId: string, companyId: string, asOfDate: string): Promise<PortalStatement> {
  // Get client info — scoped to company_id to prevent cross-tenant disclosure.
  const clients = (await sql`
    SELECT name, email FROM customers
    WHERE id = ${clientId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const client = clients[0] || { name: 'Unknown', email: '' };

  // Get all transactions for this client
  const rows = (await sql`
    SELECT invoice_date AS date, invoice_number AS reference,
           'Invoice' AS description, total AS debit, 0 AS credit
    FROM customer_invoices ci
    WHERE COALESCE(ci.client_id, ci.customer_id) = ${clientId}::UUID
      AND ci.company_id = ${companyId}::UUID
      AND ${documentInLedgerAsAtFragment('ci', asOfDate, companyId)}
      AND ci.status NOT IN ('draft', 'cancelled')
      AND ci.invoice_date <= ${asOfDate}::DATE
    UNION ALL
    SELECT payment_date AS date, reference AS reference,
           'Payment' AS description, 0 AS debit, amount AS credit
    FROM customer_payments
    WHERE COALESCE(client_id, customer_id) = ${clientId}::UUID
      AND company_id = ${companyId}::UUID
      AND status = 'posted'
      AND payment_date <= ${asOfDate}::DATE
    ORDER BY date ASC
  `) as DbRow[];

  let runningBalance = 0;
  const transactions = rows.map((r: DbRow) => {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    runningBalance += debit - credit;
    return {
      date: String(r.date),
      reference: r.reference ? String(r.reference) : '',
      description: String(r.description),
      debit,
      credit,
      balance: runningBalance,
    };
  });

  return {
    clientName: String(client.name),
    clientEmail: client.email ? String(client.email) : '',
    asOfDate,
    openingBalance: 0,
    transactions,
    closingBalance: runningBalance,
  };
}

// ── Payment Links ────────────────────────────────────────────────────────────

export async function createPaymentLink(invoiceId: string, clientId: string, amount: number): Promise<string> {
  const rows = (await sql`
    INSERT INTO portal_payment_links (invoice_id, client_id, amount)
    VALUES (${invoiceId}::UUID, ${clientId}::UUID, ${amount})
    RETURNING token
  `) as DbRow[];
  return String(rows[0]!.token);
}

export async function getPaymentLink(token: string): Promise<{
  invoiceId: string;
  clientId: string;
  amount: number;
  status: string;
  expiresAt: string;
} | null> {
  const rows = (await sql`
    SELECT * FROM portal_payment_links WHERE token = ${token} AND status = 'active' AND expires_at > NOW()
  `) as DbRow[];
  if (!rows[0]) return null;
  return {
    invoiceId: String(rows[0].invoice_id),
    clientId: String(rows[0].client_id),
    amount: Number(rows[0].amount),
    status: String(rows[0].status),
    expiresAt: String(rows[0].expires_at),
  };
}

export async function markPaymentLinkPaid(token: string, reference: string): Promise<void> {
  await sql`
    UPDATE portal_payment_links SET status = 'paid', paid_at = NOW(), payment_reference = ${reference}
    WHERE token = ${token}
  `;
}

// ── Mappers ──────────────────────────────────────────────────────────────────

function mapPortalUser(r: DbRow): PortalUser {
  return {
    id: String(r.id),
    clientId: String(r.client_id),
    companyId: String(r.customer_company_id ?? ''),
    email: String(r.email),
    name: String(r.name),
    isActive: Boolean(r.is_active),
    lastLoginAt: r.last_login_at ? String(r.last_login_at) : null,
  };
}
