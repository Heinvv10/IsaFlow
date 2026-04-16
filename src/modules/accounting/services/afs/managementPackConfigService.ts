// src/modules/accounting/services/afs/managementPackConfigService.ts
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ManagementPackConfig } from './afsTypes';

type Row = DbRow;

const DEFAULT_SECTIONS_ENABLED: Record<string, boolean> = {
  cover: true,
  ai_executive_summary: true,
  kpi_scorecard: true,
  income_statement: true,
  income_vs_budget: true,
  balance_sheet: true,
  cash_flow: true,
  debtors_ageing: true,
  creditors_ageing: true,
  bank_reconciliation: true,
  revenue_analysis: false,
  expense_analysis: false,
  budget_variance: false,
  cash_flow_forecast: false,
  vat_dashboard: false,
  cfo_narrative: false,
};

const DEFAULT_CONFIG: Omit<ManagementPackConfig, 'id' | 'companyId'> = {
  enabled: false,
  generationDay: 5,
  deliveryDay: 10,
  reviewRequired: true,
  sectionsEnabled: DEFAULT_SECTIONS_ENABLED,
  recipients: [],
  packStyle: 'detailed',
  comparisonMode: 'prior_month',
  currencyDisplay: 'full',
};

function mapRow(row: Row): ManagementPackConfig {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    enabled: Boolean(row.enabled),
    generationDay: Number(row.generation_day),
    deliveryDay: Number(row.delivery_day),
    reviewRequired: Boolean(row.review_required),
    sectionsEnabled: (row.sections_enabled as Record<string, boolean>) ?? DEFAULT_SECTIONS_ENABLED,
    recipients: (row.recipients as ManagementPackConfig['recipients']) ?? [],
    packStyle: String(row.pack_style) as ManagementPackConfig['packStyle'],
    comparisonMode: String(row.comparison_mode) as ManagementPackConfig['comparisonMode'],
    currencyDisplay: String(row.currency_display) as ManagementPackConfig['currencyDisplay'],
  };
}

export async function getManagementPackConfig(companyId: string): Promise<ManagementPackConfig> {
  const rows = (await sql`
    SELECT * FROM management_pack_configs
    WHERE company_id = ${companyId}::UUID
  `) as Row[];

  const first = rows[0];
  if (!first) {
    log.info('No config found, returning defaults', { companyId }, 'managementPackConfigService');
    return { id: '', companyId, ...DEFAULT_CONFIG };
  }
  return mapRow(first);
}

export async function upsertManagementPackConfig(
  companyId: string,
  updates: Partial<ManagementPackConfig>,
): Promise<ManagementPackConfig> {
  const current = await getManagementPackConfig(companyId);
  const merged = { ...current, ...updates };

  const rows = (await sql`
    INSERT INTO management_pack_configs (
      company_id, enabled, generation_day, delivery_day,
      review_required, sections_enabled, recipients,
      pack_style, comparison_mode, currency_display, updated_at
    ) VALUES (
      ${companyId}::UUID,
      ${merged.enabled},
      ${merged.generationDay},
      ${merged.deliveryDay},
      ${merged.reviewRequired},
      ${JSON.stringify(merged.sectionsEnabled)}::jsonb,
      ${JSON.stringify(merged.recipients)}::jsonb,
      ${merged.packStyle},
      ${merged.comparisonMode},
      ${merged.currencyDisplay},
      NOW()
    )
    ON CONFLICT (company_id) DO UPDATE SET
      enabled          = EXCLUDED.enabled,
      generation_day   = EXCLUDED.generation_day,
      delivery_day     = EXCLUDED.delivery_day,
      review_required  = EXCLUDED.review_required,
      sections_enabled = EXCLUDED.sections_enabled,
      recipients       = EXCLUDED.recipients,
      pack_style       = EXCLUDED.pack_style,
      comparison_mode  = EXCLUDED.comparison_mode,
      currency_display = EXCLUDED.currency_display,
      updated_at       = NOW()
    RETURNING *
  `) as Row[];

  log.info('Config upserted', { companyId }, 'managementPackConfigService');
  const upserted = rows[0];
  if (!upserted) throw new Error('Upsert returned no row for company ' + companyId);
  return mapRow(upserted);
}

export async function getCompaniesScheduledForDate(
  dayOfMonth: number,
): Promise<Array<{ companyId: string; config: ManagementPackConfig }>> {
  const rows = (await sql`
    SELECT * FROM management_pack_configs
    WHERE enabled = TRUE AND generation_day = ${dayOfMonth}
  `) as Row[];

  return rows.map((row) => ({
    companyId: String(row.company_id),
    config: mapRow(row),
  }));
}
