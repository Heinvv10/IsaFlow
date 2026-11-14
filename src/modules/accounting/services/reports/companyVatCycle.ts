/** The company's VAT filing cycle (cadence and alignment), or null when it is not a VAT vendor. */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { normalizeVatAlignment, normalizeVatSetting, type VatAlignment, type VatCadence } from '@/modules/bureau/services/vatPeriodHelper';

export interface VatCycle { cadence: VatCadence; alignment: VatAlignment }

export async function getCompanyVatCycle(companyId: string): Promise<VatCycle | null> {
  const rows = (await sql`
    SELECT vat_period, vat_system_type, vat_period_alignment FROM companies WHERE id = ${companyId}::UUID
  `) as DbRow[];
  const row = rows[0];
  const setting = normalizeVatSetting(row?.vat_period as string | null, row?.vat_system_type as string | null);
  return setting === 'none' ? null : { cadence: setting, alignment: normalizeVatAlignment(row?.vat_period_alignment as string | null) };
}
