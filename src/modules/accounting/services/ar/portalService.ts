/**
 * Client Portal Service
 * Customer-facing self-service: view invoices, download statements, payment links.
 */

import { sql } from '@/lib/neon';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import bcrypt from 'bcryptjs';
import type { DbRow } from '@/types/db';
import { asAtTodayStr, documentInLedgerAsAtFragment } from '../shared/softDeleteLedgerPresence';
import { documentInPopulationExpr } from '../shared/documentPopulation';
import { fetchStatementData } from './statementEmailService';
import { getClientOverdue } from './portalOverdue';
import type { StatementTransaction } from './statementEmailTypes';


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
  /** NULL on the row is kept in the population (documentPopulation); the portal shows no badge for it. */
  status: string | null;
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
  /** portalOverdue's figure — the one the chat quotes. */
  overdueAmount: number;
}

// ── Portal Auth ──────────────────────────────────────────────────────────────

export async function authenticatePortalUser(email: string, password: string): Promise<PortalUser | null> {
  // Join customers to bind the portal session to a specific company — pentest H2
  // fixed the missing company_id scope in downstream queries; the token now
  // carries companyId so it's verified against a single tenant.
  // R-095 L4: a soft-deleted customer has no portal account left to reach —
  // the record is hidden everywhere else (customer-statement.ts,
  // customerLedgerService) — so login must not mint a session for one.
  //
  // On the migration_admin pool (S-07d, migration 935): no app role may read
  // password_hash, or write portal_access at all, so a password hash cannot be
  // planted or lifted from an app pool. bcrypt runs between the two
  // transactions, holding none of that pool's few connections.
  const rows = await migrationAdminTx('portal login lookup', async (client) => (await client.query(
    `SELECT pa.*, c.company_id AS customer_company_id
       FROM portal_access pa
       JOIN customers c ON c.id = pa.client_id
      WHERE pa.email = $1 AND pa.is_active = true AND c.deleted_at IS NULL`,
    [email],
  )).rows as DbRow[]);
  if (!rows[0]) return null;

  const valid = await bcrypt.compare(password, String(rows[0].password_hash));
  if (!valid) return null;

  await migrationAdminTx('portal login stamp', (client) => client.query(
    'UPDATE portal_access SET last_login_at = NOW() WHERE id = $1::UUID', [String(rows[0]!.id)],
  ));
  return mapPortalUser(rows[0]);
}

// ── Portal Data ──────────────────────────────────────────────────────────────

/**
 * Returns null when the customer does not exist for this company (soft-deleted
 * or a companyId/clientId combination that doesn't match) — the caller 404s,
 * matching getClientStatement (R-095 L4: the two views used to disagree —
 * a soft-deleted customer got a 404 on the statement but still saw their
 * invoice list).
 */
export async function getClientInvoices(clientId: string, companyId: string): Promise<PortalInvoice[] | null> {
  const customers = (await sql`
    SELECT id FROM customers WHERE id = ${clientId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
  `) as DbRow[];
  if (customers.length === 0) return null;

  // COALESCE(client_id, customer_id) — both columns historically exist (see CLAUDE.md).
  const rows = (await sql`
    SELECT id, invoice_number, invoice_date, due_date, total_amount,
           COALESCE(amount_paid, 0) AS amount_paid,
           (total_amount - COALESCE(amount_paid, 0)) AS balance,
           status
    FROM customer_invoices ci
    WHERE COALESCE(ci.client_id, ci.customer_id) = ${clientId}::UUID
      AND ci.company_id = ${companyId}::UUID
        -- K-053: a soft-deleted invoice leaves this list exactly when the
        -- delete's GL reversal reaches the ledger, and not one day earlier.
        -- See shared/softDeleteLedgerPresence.
      AND ${documentInLedgerAsAtFragment('ci', asAtTodayStr(), companyId)}
      -- R-095/R-082: routed through the shared population rule instead of the
      -- bare NOT IN ('draft', 'cancelled'), which admitted pending_approval
      -- and silently dropped a NULL-status invoice via NULL propagation.
      AND ${sql.unsafe(documentInPopulationExpr('ci'))}
    ORDER BY ci.invoice_date DESC
  `) as DbRow[];

  return rows.map((r: DbRow) => ({
    id: String(r.id),
    invoiceNumber: String(r.invoice_number),
    // pg hands DATE columns back as Date objects; String() of one is
    // "Mon Jul 23 2026 00:00:00 GMT+0200 …", not a date the portal can show.
    invoiceDate: fmtDate(r.invoice_date),
    dueDate: fmtDate(r.due_date),
    total: Number(r.total_amount),
    amountPaid: Number(r.amount_paid),
    balance: Number(r.balance),
    status: r.status == null ? null : String(r.status),
  }));
}

const PORTAL_TRANSACTION_DESCRIPTION: Record<StatementTransaction['type'], string> = {
  invoice: 'Invoice',
  payment: 'Payment',
  credit_note: 'Credit Note',
};

/**
 * R-095: this used to be a hand-rolled parallel query — selecting a `total`
 * column that doesn't exist on customer_invoices (it's `total_amount`) and
 * filtering payments on `status = 'posted'`, a value the CHECK constraint
 * forbids — so the route 500s on every call. Routed through the SAME service
 * the in-app emailed statement uses (statementEmailService.fetchStatementData)
 * so the portal cannot drift from those figures the way a second query would,
 * and so it inherits R-082's population rule (draft/pending_approval excluded,
 * NULL-status kept, only confirmed/reconciled payments settle) for free.
 * Returns null when the customer does not exist for this company (soft-deleted
 * or a companyId/clientId combination that doesn't match) — the caller 404s.
 */
export async function getClientStatement(
  clientId: string,
  companyId: string,
  asOfDate: string
): Promise<PortalStatement | null> {
  const data = await fetchStatementData(companyId, clientId, asOfDate);
  if (!data) return null;

  return {
    clientName: data.customer.name,
    clientEmail: data.customer.email ?? '',
    asOfDate,
    openingBalance: 0,
    transactions: data.transactions.map(t => {
      // A refund is a customer_payments row with a NEGATIVE total, so the
      // statement carries it as a negative credit that RAISES the balance.
      // Shown as-is it read "Payment … R 100,00 CR" beside a balance going
      // up. It is money paid back to the customer: a debit, named a refund.
      // The running balance is fetchStatementData's, untouched.
      const refund = t.type === 'payment' && t.credit < 0;
      return {
        date: t.date,
        reference: t.reference,
        description: refund ? 'Refund' : PORTAL_TRANSACTION_DESCRIPTION[t.type],
        debit: refund ? -t.credit : t.debit,
        credit: refund ? 0 : t.credit,
        balance: t.balance,
      };
    }),
    closingBalance: data.summary.balance,
    overdueAmount: await getClientOverdue(clientId, companyId, asOfDate, data.summary.balance),
  };
}

// ── Payment Links ────────────────────────────────────────────────────────────

export async function createPaymentLink(invoiceId: string, clientId: string, amount: number): Promise<string> {
  // R-167: an explicit-amount link charges its amount (capped at the balance) and is spent by one
  // payment; the column defaults to the invoice's standing kind.
  const rows = (await sql`
    INSERT INTO portal_payment_links (invoice_id, client_id, amount, charges_balance)
    VALUES (${invoiceId}::UUID, ${clientId}::UUID, ${amount}, false)
    RETURNING token
  `) as DbRow[];
  return String(rows[0]!.token);
}

/** The link row for display. Whether it may be shown or paid is `resolveLinkCharge`'s call, not this one's. */
export async function getPaymentLink(token: string): Promise<{
  invoiceId: string;
  clientId: string;
  amount: number;
  status: string;
  expiresAt: string | null;
} | null> {
  const rows = (await sql`
    SELECT * FROM portal_payment_links
    WHERE token = ${token}
  `) as DbRow[];
  if (!rows[0]) return null;
  return {
    invoiceId: String(rows[0].invoice_id),
    clientId: String(rows[0].client_id),
    amount: Number(rows[0].amount),
    status: String(rows[0].status),
    expiresAt: rows[0].expires_at == null ? null : String(rows[0].expires_at),
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
