/**
 * Client Portal Service
 * Customer-facing self-service: view invoices, download statements, payment links.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import bcrypt from 'bcryptjs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

// ── Types ────────────────────────────────────────────────────────────────────

export interface PortalUser {
  id: string;
  clientId: string;
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
  `) as Row[];
  log.info('Portal user created', { email: input.email }, 'portal');
  return mapPortalUser(rows[0]);
}

export async function authenticatePortalUser(email: string, password: string): Promise<PortalUser | null> {
  const rows = (await sql`
    SELECT * FROM portal_access WHERE email = ${email} AND is_active = true
  `) as Row[];
  if (!rows[0]) return null;

  const valid = await bcrypt.compare(password, rows[0].password_hash);
  if (!valid) return null;

  await sql`UPDATE portal_access SET last_login_at = NOW() WHERE id = ${rows[0].id}::UUID`;
  return mapPortalUser(rows[0]);
}

export async function listPortalUsers(clientId?: string): Promise<PortalUser[]> {
  const rows = clientId
    ? (await sql`SELECT * FROM portal_access WHERE client_id = ${clientId}::UUID ORDER BY name`) as Row[]
    : (await sql`SELECT * FROM portal_access ORDER BY name`) as Row[];
  return rows.map(mapPortalUser);
}

// ── Portal Data ──────────────────────────────────────────────────────────────

export async function getClientInvoices(clientId: string): Promise<PortalInvoice[]> {
  const rows = (await sql`
    SELECT id, invoice_number, invoice_date, due_date, total,
           COALESCE(amount_paid, 0) AS amount_paid,
           (total - COALESCE(amount_paid, 0)) AS balance,
           status
    FROM customer_invoices
    WHERE client_id = ${clientId}::UUID
      AND status NOT IN ('draft', 'cancelled')
    ORDER BY invoice_date DESC
  `) as Row[];

  return rows.map((r: Row) => ({
    id: r.id,
    invoiceNumber: r.invoice_number,
    invoiceDate: r.invoice_date,
    dueDate: r.due_date,
    total: Number(r.total),
    amountPaid: Number(r.amount_paid),
    balance: Number(r.balance),
    status: r.status,
  }));
}

export async function getClientStatement(clientId: string, asOfDate: string): Promise<PortalStatement> {
  // Get client info
  const clients = (await sql`SELECT name, email FROM customers WHERE id = ${clientId}::UUID`) as Row[];
  const client = clients[0] || { name: 'Unknown', email: '' };

  // Get all transactions for this client
  const rows = (await sql`
    SELECT invoice_date AS date, invoice_number AS reference,
           'Invoice' AS description, total AS debit, 0 AS credit
    FROM customer_invoices
    WHERE client_id = ${clientId}::UUID AND status NOT IN ('draft', 'cancelled')
      AND invoice_date <= ${asOfDate}::DATE
    UNION ALL
    SELECT payment_date AS date, reference AS reference,
           'Payment' AS description, 0 AS debit, amount AS credit
    FROM customer_payments
    WHERE client_id = ${clientId}::UUID AND status = 'posted'
      AND payment_date <= ${asOfDate}::DATE
    ORDER BY date ASC
  `) as Row[];

  let runningBalance = 0;
  const transactions = rows.map((r: Row) => {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    runningBalance += debit - credit;
    return {
      date: r.date,
      reference: r.reference || '',
      description: r.description,
      debit,
      credit,
      balance: runningBalance,
    };
  });

  return {
    clientName: client.name,
    clientEmail: client.email || '',
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
  `) as Row[];
  return rows[0].token;
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
  `) as Row[];
  if (!rows[0]) return null;
  return {
    invoiceId: rows[0].invoice_id,
    clientId: rows[0].client_id,
    amount: Number(rows[0].amount),
    status: rows[0].status,
    expiresAt: rows[0].expires_at,
  };
}

export async function markPaymentLinkPaid(token: string, reference: string): Promise<void> {
  await sql`
    UPDATE portal_payment_links SET status = 'paid', paid_at = NOW(), payment_reference = ${reference}
    WHERE token = ${token}
  `;
}

// ── Mappers ──────────────────────────────────────────────────────────────────

function mapPortalUser(r: Row): PortalUser {
  return {
    id: r.id,
    clientId: r.client_id,
    email: r.email,
    name: r.name,
    isActive: r.is_active,
    lastLoginAt: r.last_login_at,
  };
}
