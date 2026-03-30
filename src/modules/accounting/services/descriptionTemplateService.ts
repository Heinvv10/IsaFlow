/**
 * Description Template Service
 * WS-6.5: Description Templates & Auto-Suggest
 *
 * Provides template management and auto-suggest for description fields
 * using a combination of stored templates and historical GL descriptions.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export interface DescriptionTemplate {
  id: string;
  companyId: string;
  name: string;
  template: string;
  entityType?: string;
  usageCount: number;
  createdAt: Date | string;
}

export interface DescriptionSuggestion {
  text: string;
  source: 'template' | 'history';
  count?: number;
}

// ── Suggest ──────────────────────────────────────────────────────────────────

export async function suggestDescriptions(
  companyId: string,
  query: string,
  entityType?: string,
  limit = 10,
): Promise<DescriptionSuggestion[]> {
  if (!query.trim()) return [];

  const pattern = `%${query.trim()}%`;

  // 1. Matching templates
  const templateRows = (await sql`
    SELECT name, template, usage_count
    FROM transaction_description_templates
    WHERE company_id = ${companyId}::UUID
      AND (
        template ILIKE ${pattern}
        OR name ILIKE ${pattern}
      )
      ${entityType ? sql`AND (entity_type IS NULL OR entity_type = ${entityType})` : sql``}
    ORDER BY usage_count DESC, name ASC
    LIMIT ${limit}
  `) as Row[];

  const templateSuggestions: DescriptionSuggestion[] = templateRows.map(r => ({
    text: r.template as string,
    source: 'template' as const,
    count: Number(r.usage_count),
  }));

  // 2. Historical descriptions from gl_journal_entries
  const remaining = limit - templateSuggestions.length;
  const historySuggestions: DescriptionSuggestion[] = [];

  if (remaining > 0) {
    const historyRows = (await sql`
      SELECT description, COUNT(*) AS usage_count
      FROM gl_journal_entries
      WHERE company_id = ${companyId}::UUID
        AND description IS NOT NULL
        AND description <> ''
        AND description ILIKE ${pattern}
      GROUP BY description
      ORDER BY COUNT(*) DESC
      LIMIT ${remaining}
    `) as Row[];

    for (const r of historyRows) {
      const text = r.description as string;
      // Only include if not already covered by a template suggestion
      const isDuplicate = templateSuggestions.some(s => s.text === text);
      if (!isDuplicate) {
        historySuggestions.push({
          text,
          source: 'history',
          count: Number(r.usage_count),
        });
      }
    }
  }

  return [...templateSuggestions, ...historySuggestions];
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function getTemplates(
  companyId: string,
  entityType?: string,
): Promise<DescriptionTemplate[]> {
  const rows = (await sql`
    SELECT
      id, company_id, name, template, entity_type, usage_count, created_at
    FROM transaction_description_templates
    WHERE company_id = ${companyId}::UUID
      ${entityType ? sql`AND (entity_type IS NULL OR entity_type = ${entityType})` : sql``}
    ORDER BY usage_count DESC, name ASC
  `) as Row[];

  return rows.map(mapRow);
}

export async function createTemplate(
  companyId: string,
  name: string,
  template: string,
  entityType?: string,
): Promise<DescriptionTemplate> {
  if (!name.trim() || !template.trim()) {
    throw new Error('name and template are required');
  }

  const rows = (await sql`
    INSERT INTO transaction_description_templates (company_id, name, template, entity_type)
    VALUES (${companyId}::UUID, ${name.trim()}, ${template.trim()}, ${entityType ?? null})
    ON CONFLICT (company_id, name)
    DO UPDATE SET template = EXCLUDED.template, entity_type = EXCLUDED.entity_type
    RETURNING id, company_id, name, template, entity_type, usage_count, created_at
  `) as Row[];

  const row = rows[0];
  if (!row) throw new Error('Failed to create template');

  log.info('Description template created', { companyId, name }, 'descriptionTemplateService');
  return mapRow(row);
}

export async function deleteTemplate(
  companyId: string,
  id: string,
): Promise<void> {
  await sql`
    DELETE FROM transaction_description_templates
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;
  log.info('Description template deleted', { companyId, id }, 'descriptionTemplateService');
}

export async function incrementUsageCount(
  companyId: string,
  templateText: string,
): Promise<void> {
  await sql`
    UPDATE transaction_description_templates
    SET usage_count = usage_count + 1
    WHERE company_id = ${companyId}::UUID
      AND template = ${templateText}
  `;
}

// ── Mapper ───────────────────────────────────────────────────────────────────

function mapRow(r: Row): DescriptionTemplate {
  return {
    id: r.id as string,
    companyId: r.company_id as string,
    name: r.name as string,
    template: r.template as string,
    entityType: r.entity_type as string | undefined,
    usageCount: Number(r.usage_count),
    createdAt: r.created_at as Date | string,
  };
}
