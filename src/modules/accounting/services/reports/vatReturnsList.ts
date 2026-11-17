/** vat_returns rows as records, and the list the GET route serves (split from vatSubmissionService). */

import { toIsoTimestamp } from '@/lib/dateUtils';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

// ── Public types ─────────────────────────────────────────────────────────────

export interface VATSubmitInput {
  periodStart: string;
  periodEnd: string;
  sarsReference?: string;
  /** Settle although the control accounts and the VAT201 differ (owner/admin, with a reason; wave 6 VR). */
  acknowledgeLedgerGap?: { reason: string; role: string };
}

export interface VATReturnRecord {
  id: string;
  companyId: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  totalOutputTax: number;
  totalInputTax: number;
  netVat: number;
  sarsReference?: string;
  submittedAt: string;
  submittedBy?: string;
  journalEntryId?: string;
  /** The VAT201 version this settlement was posted against; absent for one settled before the lifecycle. */
  returnVersionId?: string;
  /** Settled although the control accounts' net VAT differed from the VAT201's, with the reason given. */
  ledgerGap?: { ledgerNetVat: number; reportNetVat: number; reason: string };
  createdAt: string;
  updatedAt: string;
}

export interface ListVATReturnsOptions {
  year?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function mapRow(row: Row): VATReturnRecord {
  return {
    id:             String(row.id),
    companyId:      String(row.company_id),
    periodStart:    String(row.period_start),
    periodEnd:      String(row.period_end),
    status:         String(row.status),
    totalOutputTax: Number(row.total_output_tax),
    totalInputTax:  Number(row.total_input_tax),
    netVat:         Number(row.net_vat),
    sarsReference:  row.sars_reference ? String(row.sars_reference) : undefined,
    submittedAt:    toIsoTimestamp(row.submitted_at as Date | string) ?? '',
    submittedBy:    row.submitted_by ? String(row.submitted_by) : undefined,
    journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : undefined,
    returnVersionId: row.return_version_id ? String(row.return_version_id) : undefined,
    ledgerGap: row.ledger_gap_reason == null ? undefined : {
      ledgerNetVat: Number(row.ledger_gap_ledger_net), reportNetVat: Number(row.ledger_gap_report_net),
      reason: String(row.ledger_gap_reason),
    },
    createdAt:      toIsoTimestamp(row.created_at as Date | string) ?? '',
    updatedAt:      toIsoTimestamp(row.updated_at as Date | string) ?? '',
  };
}

// ── listVATReturns ────────────────────────────────────────────────────────────

export async function listVATReturns(
  companyId: string,
  options?: ListVATReturnsOptions,
): Promise<VATReturnRecord[]> {
  const rows = options?.year
    ? (await sql`
        SELECT * FROM vat_returns
        WHERE company_id = ${companyId}::UUID
          AND EXTRACT(YEAR FROM period_start) = ${options.year}
        ORDER BY period_start DESC
      `) as Row[]
    : (await sql`
        SELECT * FROM vat_returns
        WHERE company_id = ${companyId}::UUID
        ORDER BY period_start DESC
        LIMIT 50
      `) as Row[];

  return rows.map(mapRow);
}
