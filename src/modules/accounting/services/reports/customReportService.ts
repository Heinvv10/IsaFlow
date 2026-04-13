/**
 * Custom Report Builder Service — WS-7.1
 * CRUD for report templates. Query execution is in customReportRunner.ts.
 * All SQL is parameterized and scoped to company_id.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getAvailableFields } from './customReportFieldDefs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReportColumn {
  field: string;
  label?: string;
  width?: number;
}

export interface ReportFilter {
  field: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'starts_with' |
    'greater_than' | 'less_than' | 'between' | 'in' | 'is_null' | 'is_not_null';
  value?: string | number;
  value2?: string | number;
}

export interface ReportSort {
  field: string;
  direction: 'asc' | 'desc';
}

export interface ReportConfig {
  dataSource: string;
  columns: ReportColumn[];
  filters?: ReportFilter[];
  sortBy?: ReportSort[];
  groupBy?: string[];
  limit?: number;
  offset?: number;
}

export interface RunResult {
  columns: Array<{ field: string; label: string; type: string }>;
  rows: Row[];
  totals: Record<string, number>;
  rowCount: number;
}

export interface ReportTemplate {
  id: string;
  companyId: string;
  createdBy: string;
  name: string;
  description: string | null;
  dataSource: string;
  columns: ReportColumn[];
  filters: ReportFilter[];
  sortBy: ReportSort[];
  groupBy: string[];
  totals: Record<string, boolean>;
  layoutOptions: Record<string, unknown>;
  isShared: boolean;
  schedule: unknown | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface TemplateInput {
  id?: string;
  name: string;
  description?: string;
  dataSource: string;
  columns: ReportColumn[];
  filters?: ReportFilter[];
  sortBy?: ReportSort[];
  groupBy?: string[];
  totals?: Record<string, boolean>;
  layoutOptions?: Record<string, unknown>;
  isShared?: boolean;
  schedule?: unknown;
}

// Re-exports
export { getAvailableFields };
export { runReport } from './customReportRunner';

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function getTemplates(companyId: string, userId: string): Promise<ReportTemplate[]> {
  const rows = await sql`
    SELECT id, company_id, created_by, name, description, data_source,
      columns, filters, sort_by, group_by, totals, layout_options,
      is_shared, schedule, created_at, updated_at
    FROM custom_report_templates
    WHERE company_id = ${companyId}
      AND (created_by = ${userId} OR is_shared = true)
    ORDER BY updated_at DESC
  `;
  return rows.map(r => mapTemplate(r as Row));
}

export async function getTemplateById(companyId: string, id: string): Promise<ReportTemplate | null> {
  const rows = await sql`
    SELECT id, company_id, created_by, name, description, data_source,
      columns, filters, sort_by, group_by, totals, layout_options,
      is_shared, schedule, created_at, updated_at
    FROM custom_report_templates
    WHERE company_id = ${companyId} AND id = ${id}
  `;
  if (!rows[0]) return null;
  return mapTemplate(rows[0] as Row);
}

export async function saveTemplate(
  companyId: string,
  userId: string,
  input: TemplateInput,
): Promise<ReportTemplate> {
  const cols    = JSON.stringify(input.columns ?? []);
  const filters = JSON.stringify(input.filters ?? []);
  const sortBy  = JSON.stringify(input.sortBy ?? []);
  const groupBy = JSON.stringify(input.groupBy ?? []);
  const totals  = JSON.stringify(input.totals ?? {});
  const layout  = JSON.stringify(input.layoutOptions ?? {});
  const sched   = input.schedule ? JSON.stringify(input.schedule) : null;
  const shared  = input.isShared ?? false;

  if (input.id) {
    const existing = await getTemplateById(companyId, input.id);
    if (!existing) throw new Error('Template not found');
    if (existing.createdBy !== userId) throw new Error('You do not own this template');

    const rows = await sql`
      UPDATE custom_report_templates SET
        name = ${input.name}, description = ${input.description ?? null},
        data_source = ${input.dataSource},
        columns = ${cols}::jsonb, filters = ${filters}::jsonb,
        sort_by = ${sortBy}::jsonb, group_by = ${groupBy}::jsonb,
        totals = ${totals}::jsonb, layout_options = ${layout}::jsonb,
        is_shared = ${shared}, schedule = ${sched}::jsonb,
        updated_at = NOW()
      WHERE company_id = ${companyId} AND id = ${input.id}
      RETURNING *
    `;
    if (!rows[0]) throw new Error('Update returned no row');
    log.info('Template updated', { id: input.id, companyId }, 'CustomReportService');
    return mapTemplate(rows[0] as Row);
  }

  const rows = await sql`
    INSERT INTO custom_report_templates
      (company_id, created_by, name, description, data_source, columns, filters,
       sort_by, group_by, totals, layout_options, is_shared, schedule)
    VALUES (
      ${companyId}, ${userId}, ${input.name}, ${input.description ?? null},
      ${input.dataSource}, ${cols}::jsonb, ${filters}::jsonb,
      ${sortBy}::jsonb, ${groupBy}::jsonb, ${totals}::jsonb, ${layout}::jsonb,
      ${shared}, ${sched}::jsonb
    )
    RETURNING *
  `;
  if (!rows[0]) throw new Error('Insert returned no row');
  log.info('Template created', { id: (rows[0] as Row).id, companyId }, 'CustomReportService');
  return mapTemplate(rows[0] as Row);
}

export async function deleteTemplate(companyId: string, userId: string, id: string): Promise<void> {
  const existing = await getTemplateById(companyId, id);
  if (!existing) throw new Error('Template not found');
  if (existing.createdBy !== userId) throw new Error('You do not own this template');
  await sql`DELETE FROM custom_report_templates WHERE company_id = ${companyId} AND id = ${id}`;
  log.info('Template deleted', { id, companyId }, 'CustomReportService');
}

// ─── Mapper ──────────────────────────────────────────────────────────────────

function mapTemplate(r: Row): ReportTemplate {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    createdBy: String(r.created_by),
    name: String(r.name),
    description: r.description ? String(r.description) : null,
    dataSource: String(r.data_source),
    columns: (r.columns ?? []) as ReportColumn[],
    filters: (r.filters ?? []) as ReportFilter[],
    sortBy: (r.sort_by ?? []) as ReportSort[],
    groupBy: (r.group_by ?? []) as string[],
    totals: (r.totals ?? {}) as Record<string, boolean>,
    layoutOptions: (r.layout_options ?? {}) as Record<string, unknown>,
    isShared: Boolean(r.is_shared),
    schedule: r.schedule ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
