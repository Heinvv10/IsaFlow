/**
 * Transaction Reporting Service
 * Customer and supplier transaction reports.
 * Bank, account, and audit trail reports live in transactionLedgerService.ts.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

// Re-export ledger reports for backward compatibility
export type {
  BankTransactionRow,
  BankTransactionsReport,
  AccountTransactionsReport,
  AuditTrailRow,
} from '../gl/transactionLedgerService';
export {
  getBankTransactions,
  getAccountTransactions,
  getAuditTrail,
} from '../gl/transactionLedgerService';

type Row = DbRow;

// ── Customer Report ─────────────────────────────────────────────────────────

export interface CustomerReportRow {
  clientId: string;
  clientName: string;
  invoiceCount: number;
  totalInvoiced: number;
  totalPaid: number;
  balance: number;
}

export async function getCustomerReport(
  companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<CustomerReportRow[]> {
  try {
    const rows = (await sql`
      SELECT
        c.id AS client_id,
        c.name AS client_name,
        COUNT(DISTINCT ci.id) AS invoice_count,
        COALESCE(SUM(ci.total_amount), 0) AS total_invoiced,
        COALESCE(SUM(ci.amount_paid), 0) AS total_paid
      FROM customers c
      LEFT JOIN customer_invoices ci ON ci.client_id = c.id
        AND ci.company_id = ${companyId}::UUID
        AND ci.invoice_date >= ${periodStart}
        AND ci.invoice_date <= ${periodEnd}
        AND ci.status NOT IN ('draft', 'cancelled')
      WHERE c.company_id = ${companyId}::UUID
      GROUP BY c.id, c.name
      HAVING COUNT(ci.id) > 0
      ORDER BY COALESCE(SUM(ci.total_amount), 0) DESC
    `) as Row[];

    return rows.map((r: Row) => ({
      clientId: String(r.client_id),
      clientName: String(r.client_name),
      invoiceCount: Number(r.invoice_count),
      totalInvoiced: Number(r.total_invoiced),
      totalPaid: Number(r.total_paid),
      balance: Number(r.total_invoiced) - Number(r.total_paid),
    }));
  } catch (err) {
    log.error('Failed to generate customer report', { error: err }, 'accounting');
    throw err;
  }
}

// ── Supplier Report ─────────────────────────────────────────────────────────

export interface SupplierReportRow {
  supplierId: string;
  supplierName: string;
  invoiceCount: number;
  totalInvoiced: number;
  totalPaid: number;
  balance: number;
}

export async function getSupplierReport(
  companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<SupplierReportRow[]> {
  try {
    const rows = (await sql`
      SELECT
        s.id AS supplier_id,
        COALESCE(s.company_name, s.name) AS supplier_name,
        COUNT(DISTINCT si.id) AS invoice_count,
        COALESCE(SUM(si.total_amount), 0) AS total_invoiced,
        COALESCE(SUM(si.amount_paid), 0) AS total_paid
      FROM suppliers s
      LEFT JOIN supplier_invoices si ON si.supplier_id = s.id
        AND si.company_id = ${companyId}::UUID
        AND si.invoice_date >= ${periodStart}
        AND si.invoice_date <= ${periodEnd}
        AND si.status NOT IN ('draft', 'cancelled')
      WHERE s.company_id = ${companyId}::UUID
      GROUP BY s.id, s.company_name, s.name
      HAVING COUNT(si.id) > 0
      ORDER BY COALESCE(SUM(si.total_amount), 0) DESC
    `) as Row[];

    return rows.map((r: Row) => ({
      supplierId: String(r.supplier_id),
      supplierName: String(r.supplier_name),
      invoiceCount: Number(r.invoice_count),
      totalInvoiced: Number(r.total_invoiced),
      totalPaid: Number(r.total_paid),
      balance: Number(r.total_invoiced) - Number(r.total_paid),
    }));
  } catch (err) {
    log.error('Failed to generate supplier report', { error: err }, 'accounting');
    throw err;
  }
}
