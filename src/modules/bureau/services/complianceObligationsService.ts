/**
 * CRUD for the per-company statutory obligation config
 * (company_compliance_obligations, mig 494). Consumed by the compliance
 * calendar signal and the Compliance settings tab. Company-scoped.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

export interface ComplianceObligations {
  vatEnabled: boolean;
  emp201Enabled: boolean;
  emp501Enabled: boolean;
  provisionalTaxEnabled: boolean;
  cipcEnabled: boolean;
  yearEndMonth: number;
  cipcAnniversaryMonth: number | null;
}

type Row = Record<string, unknown>;

function mapRow(r: Row): ComplianceObligations {
  return {
    vatEnabled: Boolean(r.vat_enabled),
    emp201Enabled: Boolean(r.emp201_enabled),
    emp501Enabled: Boolean(r.emp501_enabled),
    provisionalTaxEnabled: Boolean(r.provisional_tax_enabled),
    cipcEnabled: Boolean(r.cipc_enabled),
    yearEndMonth: Number(r.year_end_month) || 2,
    cipcAnniversaryMonth: r.cipc_anniversary_month == null ? null : Number(r.cipc_anniversary_month),
  };
}

/** Returns null when the company has no config row (= no obligations). */
export async function getObligations(companyId: string): Promise<ComplianceObligations | null> {
  const rows = (await sql`
    SELECT vat_enabled, emp201_enabled, emp501_enabled, provisional_tax_enabled,
           cipc_enabled, year_end_month, cipc_anniversary_month
      FROM company_compliance_obligations
     WHERE company_id = ${companyId}::UUID
  `) as Row[];
  return rows.length > 0 ? mapRow(rows[0]!) : null;
}

export function validateObligations(input: ComplianceObligations): string | null {
  if (!Number.isInteger(input.yearEndMonth) || input.yearEndMonth < 1 || input.yearEndMonth > 12) {
    return 'yearEndMonth must be an integer between 1 and 12';
  }
  if (
    input.cipcAnniversaryMonth !== null &&
    (!Number.isInteger(input.cipcAnniversaryMonth) ||
      input.cipcAnniversaryMonth < 1 ||
      input.cipcAnniversaryMonth > 12)
  ) {
    return 'cipcAnniversaryMonth must be null or an integer between 1 and 12';
  }
  if (input.cipcEnabled && input.cipcAnniversaryMonth === null) {
    return 'cipcAnniversaryMonth is required when the CIPC annual return is enabled';
  }
  return null;
}

export async function upsertObligations(
  companyId: string,
  input: ComplianceObligations,
): Promise<ComplianceObligations> {
  log.info('Upserting compliance obligations', { companyId }, 'complianceObligations');
  const rows = (await sql`
    INSERT INTO company_compliance_obligations (
      company_id, vat_enabled, emp201_enabled, emp501_enabled,
      provisional_tax_enabled, cipc_enabled, year_end_month, cipc_anniversary_month
    ) VALUES (
      ${companyId}::UUID, ${input.vatEnabled}, ${input.emp201Enabled}, ${input.emp501Enabled},
      ${input.provisionalTaxEnabled}, ${input.cipcEnabled}, ${input.yearEndMonth}, ${input.cipcAnniversaryMonth}
    )
    ON CONFLICT (company_id) DO UPDATE SET
      vat_enabled = EXCLUDED.vat_enabled,
      emp201_enabled = EXCLUDED.emp201_enabled,
      emp501_enabled = EXCLUDED.emp501_enabled,
      provisional_tax_enabled = EXCLUDED.provisional_tax_enabled,
      cipc_enabled = EXCLUDED.cipc_enabled,
      year_end_month = EXCLUDED.year_end_month,
      cipc_anniversary_month = EXCLUDED.cipc_anniversary_month,
      updated_at = now()
    RETURNING vat_enabled, emp201_enabled, emp501_enabled, provisional_tax_enabled,
              cipc_enabled, year_end_month, cipc_anniversary_month
  `) as Row[];
  return mapRow(rows[0]!);
}
