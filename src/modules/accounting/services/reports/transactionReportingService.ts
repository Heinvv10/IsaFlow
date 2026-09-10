/**
 * Transaction Reporting Service
 * Customer and supplier transaction reports.
 * Bank, account, and audit trail reports live in transactionLedgerService.ts.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { documentInLedgerAsAtFragment } from '../shared/softDeleteLedgerPresence';
import { rewindAmount, effectivePaidExpr } from '../shared/agingRewind';
import { documentInPopulationExpr } from '@/modules/accounting/services/shared/documentPopulation';

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
        COALESCE(SUM(${sql.unsafe(effectivePaidExpr('ar'))}), 0) AS total_paid
      FROM customers c
      -- COALESCE(client_id, customer_id), the K-093 key: both columns exist and
      -- an invoice may carry only customer_id, so joining on client_id alone
      -- DROPPED those invoices entirely while sales-by-customer counted them.
      LEFT JOIN customer_invoices ci ON COALESCE(ci.client_id, ci.customer_id) = c.id
        AND ci.company_id = ${companyId}::UUID
        AND ci.invoice_date >= ${periodStart}
        AND ci.invoice_date <= ${periodEnd}
        -- Status rule: shared/documentPopulation (NULL-safe, one definition).
        -- Asserted equal to sales-by-customer by r059-period-reports-as-at-
        -- period-end, over invoices whose customer row EXISTS IN THIS COMPANY:
        -- this report reads FROM customers WHERE c.company_id = the tenant, so
        -- an invoice pointing at no customer row — or at another company's,
        -- which client_id permits because it has no FK — has no line here,
        -- while sales-by-customer gives it its own Unknown customer row. That
        -- remaining difference is a data defect neither report creates.
        AND ${sql.unsafe(documentInPopulationExpr('ci'))}
        -- AS AT the period end: the invoices raised in the period and what
        -- had been paid on them by periodEnd, so the balance is the ageing at
        -- periodEnd restricted to these invoices (not the ageing's total, which
        -- also carries invoices raised earlier) and agrees with sales-by-
        -- customer over the same range. total_paid used to be TODAY's
        -- amount_paid (R-059); the rewind is the aged report's own. The soft-
        -- delete leg is dated the same way — shared/softDeleteLedgerPresence.
        AND ${documentInLedgerAsAtFragment('ci', periodEnd, companyId)}
      LEFT JOIN LATERAL (
        ${rewindAmount({ companyId, asAtStr: periodEnd, todayStr: fmtDate(new Date()), side: 'ar' })}
      ) unpaid ON TRUE
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
        COALESCE(SUM(${sql.unsafe(effectivePaidExpr('ap'))}), 0) AS total_paid
      FROM suppliers s
      LEFT JOIN supplier_invoices si ON si.supplier_id = s.id
        AND si.company_id = ${companyId}::UUID
        AND si.invoice_date >= ${periodStart}
        AND si.invoice_date <= ${periodEnd}
        -- Status rule: shared/documentPopulation (NULL-safe, one definition).
        AND ${sql.unsafe(documentInPopulationExpr('si'))}
        -- Same as the customer report above, as at the period end.
        AND ${documentInLedgerAsAtFragment('si', periodEnd, companyId)}
      LEFT JOIN LATERAL (
        ${rewindAmount({ companyId, asAtStr: periodEnd, todayStr: fmtDate(new Date()), side: 'ap' })}
      ) unpaid ON TRUE
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
