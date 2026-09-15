/**
 * PRD-06 Phase 5 follow-up — per-customer dunning overrides.
 *
 * Two knobs per customer:
 *   - suppress_dunning: cron skips this customer entirely.
 *   - template_id_override: when set, cron uses this template regardless of
 *     the invoice's days_overdue (useful for VIP "always polite" treatment
 *     or the opposite — escalate straight to 'legal' on first overdue).
 *
 * The cron walker (dunningCronService.ts) honours these at query time.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { ArRequestError } from '@/modules/accounting/services/ar/arErrors';
import { assertCustomerInCompany } from '@/modules/accounting/services/core/contactDirectoryService';

export interface CustomerDunningOverride {
  company_id: string;
  customer_id: string;
  suppress_dunning: boolean;
  template_id_override: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertOverrideInput {
  suppress_dunning?: boolean;
  template_id_override?: string | null;
  note?: string | null;
}

export async function getOverride(
  companyId: string,
  customerId: string,
): Promise<CustomerDunningOverride | null> {
  const rows = (await sql`
    SELECT company_id, customer_id, suppress_dunning, template_id_override,
           note, created_at, updated_at
    FROM customer_dunning_overrides
    WHERE company_id = ${companyId}::uuid AND customer_id = ${customerId}::uuid
    LIMIT 1
  `) as DbRow[];
  return (rows[0] as unknown as CustomerDunningOverride) ?? null;
}

export async function listOverrides(
  companyId: string,
): Promise<Array<CustomerDunningOverride & { customer_name: string }>> {
  const rows = (await sql`
    SELECT cdo.company_id, cdo.customer_id, cdo.suppress_dunning,
           cdo.template_id_override, cdo.note, cdo.created_at, cdo.updated_at,
           c.name AS customer_name
    FROM customer_dunning_overrides cdo
    JOIN customers c ON c.id = cdo.customer_id
    WHERE cdo.company_id = ${companyId}::uuid
    ORDER BY c.name ASC
  `) as DbRow[];
  return rows as unknown as Array<CustomerDunningOverride & { customer_name: string }>;
}

/**
 * Upsert. Omitted fields keep their existing value (or default on first insert).
 * Passing template_id_override: null explicitly clears the override.
 */
export async function setOverride(
  companyId: string,
  customerId: string,
  input: UpsertOverrideInput,
): Promise<CustomerDunningOverride> {
  // R-067: customer_id comes from the request body; the upsert is the first write.
  await assertCustomerInCompany(companyId, customerId);
  const current = await getOverride(companyId, customerId);
  const next = {
    suppress_dunning: input.suppress_dunning ?? current?.suppress_dunning ?? false,
    template_id_override:
      input.template_id_override !== undefined
        ? input.template_id_override
        : (current?.template_id_override ?? null),
    note: input.note !== undefined ? input.note : (current?.note ?? null),
  };

  if (next.template_id_override) {
    const exists = (await sql`
      SELECT 1 FROM dunning_templates
      WHERE id = ${next.template_id_override}::uuid AND company_id = ${companyId}::uuid
      LIMIT 1
    `) as DbRow[];
    if (exists.length === 0) {
      throw new ArRequestError(
        `Template ${next.template_id_override} not found for company`,
        404,
        'DUNNING_TEMPLATE_NOT_FOUND',
      );
    }
  }

  const rows = (await sql`
    INSERT INTO customer_dunning_overrides
      (company_id, customer_id, suppress_dunning, template_id_override, note, updated_at)
    VALUES
      (${companyId}::uuid, ${customerId}::uuid,
       ${next.suppress_dunning}, ${next.template_id_override},
       ${next.note}, NOW())
    ON CONFLICT (company_id, customer_id) DO UPDATE SET
      suppress_dunning      = EXCLUDED.suppress_dunning,
      template_id_override  = EXCLUDED.template_id_override,
      note                  = EXCLUDED.note,
      updated_at            = NOW()
    RETURNING company_id, customer_id, suppress_dunning, template_id_override,
              note, created_at, updated_at
  `) as DbRow[];
  return rows[0] as unknown as CustomerDunningOverride;
}

export async function deleteOverride(
  companyId: string,
  customerId: string,
): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM customer_dunning_overrides
    WHERE company_id = ${companyId}::uuid AND customer_id = ${customerId}::uuid
    RETURNING customer_id
  `) as DbRow[];
  return rows.length > 0;
}
