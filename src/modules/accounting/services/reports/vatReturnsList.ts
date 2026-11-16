/** vat_returns rows as records, and the list the GET route serves (split from vatSubmissionService). */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

// ── Public types ─────────────────────────────────────────────────────────────

export interface VATSubmitInput {
  periodStart: string;
  periodEnd: string;
  sarsReference?: string;
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
    submittedAt:    String(row.submitted_at),
    submittedBy:    row.submitted_by ? String(row.submitted_by) : undefined,
    journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : undefined,
    returnVersionId: row.return_version_id ? String(row.return_version_id) : undefined,
    createdAt:      String(row.created_at),
    updatedAt:      String(row.updated_at),
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
