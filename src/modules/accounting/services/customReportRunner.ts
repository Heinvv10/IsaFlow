/**
 * Custom Report Runner — WS-7.1
 * Dynamic SQL builder using whitelisted field expressions only.
 * All user-supplied values go through parameterized query bindings.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  getAvailableFields,
  getFieldDef,
  getBaseQuery,
  getCompanyAlias,
  type FieldDef,
} from './customReportFieldDefs';
import type { ReportConfig, RunResult } from './customReportService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export async function runReport(companyId: string, config: ReportConfig): Promise<RunResult> {
  const { dataSource, columns, filters = [], sortBy = [], limit = 500, offset = 0 } = config;

  const fields = getAvailableFields(dataSource);
  if (!fields.length) throw new Error(`Unknown data source: ${dataSource}`);

  // Validate & resolve selected columns against whitelist — no user input touches SQL strings
  const selectedFields = columns
    .map(c => getFieldDef(dataSource, c.field))
    .filter((f): f is FieldDef => f !== undefined);

  if (!selectedFields.length) throw new Error('No valid columns selected');

  const alias = getCompanyAlias(dataSource);
  const baseQuery = getBaseQuery(dataSource);

  // SELECT from whitelisted sqlExpr values only
  const selectParts = selectedFields.map(f => `${f.sqlExpr} AS "${f.field}"`).join(', ');

  // Parameterized WHERE clause — values bound as $N, never interpolated
  const params: (string | number | null)[] = [companyId];
  let paramIdx = 2;
  const whereParts: string[] = [`${alias}.company_id = $1`];

  for (const filter of filters) {
    const fd = getFieldDef(dataSource, filter.field);
    if (!fd || !fd.filterable) continue;

    const expr = fd.sqlExpr; // from whitelist only
    switch (filter.operator) {
      case 'equals':
        whereParts.push(`${expr} = $${paramIdx++}`);
        params.push(filter.value ?? null);
        break;
      case 'not_equals':
        whereParts.push(`${expr} != $${paramIdx++}`);
        params.push(filter.value ?? null);
        break;
      case 'contains':
        whereParts.push(`${expr}::text ILIKE $${paramIdx++}`);
        params.push(`%${filter.value ?? ''}%`);
        break;
      case 'starts_with':
        whereParts.push(`${expr}::text ILIKE $${paramIdx++}`);
        params.push(`${filter.value ?? ''}%`);
        break;
      case 'greater_than':
        whereParts.push(`${expr} > $${paramIdx++}`);
        params.push(filter.value ?? null);
        break;
      case 'less_than':
        whereParts.push(`${expr} < $${paramIdx++}`);
        params.push(filter.value ?? null);
        break;
      case 'between':
        whereParts.push(`${expr} BETWEEN $${paramIdx} AND $${paramIdx + 1}`);
        paramIdx += 2;
        params.push(filter.value ?? null, filter.value2 ?? null);
        break;
      case 'in': {
        const vals = String(filter.value ?? '').split(',').map(v => v.trim()).filter(Boolean);
        if (vals.length) {
          const placeholders = vals.map(() => `$${paramIdx++}`).join(', ');
          whereParts.push(`${expr} IN (${placeholders})`);
          params.push(...vals);
        }
        break;
      }
      case 'is_null':
        whereParts.push(`${expr} IS NULL`);
        break;
      case 'is_not_null':
        whereParts.push(`${expr} IS NOT NULL`);
        break;
    }
  }

  const whereClause = whereParts.join(' AND ');

  // ORDER BY from whitelisted fields only
  const orderParts = sortBy
    .map(s => {
      const fd = getFieldDef(dataSource, s.field);
      if (!fd || !fd.sortable) return null;
      return `${fd.sqlExpr} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`;
    })
    .filter((x): x is string => x !== null);
  const orderClause = orderParts.length ? `ORDER BY ${orderParts.join(', ')}` : '';

  const limitVal = Math.min(Math.max(1, Number(limit) || 500), 10000);
  const offsetVal = Math.max(0, Number(offset) || 0);

  // Final SQL — structure comes from whitelisted exprs, values from $N bindings
  const querySql = `
    SELECT ${selectParts}
    ${baseQuery}
    WHERE ${whereClause}
    ${orderClause}
    LIMIT ${limitVal} OFFSET ${offsetVal}
  `;

  const countSql = `
    SELECT COUNT(*) AS total
    ${baseQuery}
    WHERE ${whereClause}
  `;

  // sql.query() sends parameterized queries to Neon
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [dataRows, countRows] = await Promise.all([
    (sql as any).query(querySql, params),
    (sql as any).query(countSql, params),
  ]);

  const rows = (dataRows.rows ?? dataRows) as Row[];
  const rowCount = Number((countRows.rows ?? countRows)[0]?.total ?? rows.length);

  // Aggregate totals for totalable fields
  const totals: Record<string, number> = {};
  for (const f of selectedFields) {
    if (f.totalable) {
      totals[f.field] = rows.reduce((sum, r) => sum + (Number(r[f.field]) || 0), 0);
    }
  }

  const resultColumns = selectedFields.map(f => ({
    field: f.field,
    label: columns.find(c => c.field === f.field)?.label ?? f.label,
    type: f.type,
  }));

  log.info('Custom report executed', { dataSource, rowCount, companyId }, 'CustomReportRunner');

  return { columns: resultColumns, rows, totals, rowCount };
}
