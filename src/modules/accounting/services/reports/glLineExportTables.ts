/**
 * The export's dimension master files (§9.1: "plus the dimension tables … one
 * file per table"): accounts, cost centres, business units, counterparties.
 * Every code a line carries resolves to a row here.
 *
 * PAGED like the lines, with a keyset over a total order, so a company with
 * fifty thousand customers is never one response. The order is the row's id
 * (counterparties: 'Customer' rows, then 'Supplier' rows, each by id) and the
 * cursor is that key — never a code or a name. A name in the cursor broke
 * paging past ~280 characters (the MCP cursor is capped) and put user text on
 * the wire (PR #688 round 2). Every read is this company's rows only.
 *
 * Counterparties carry names and VAT numbers (personal information for a sole
 * trader), so the MCP tool serves that table only to a token that also holds
 * read:contacts — see exportGlLines.ts.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import { CASH_SUBTYPES } from '@/modules/accounting/services/gl/accountSubtypes';
import { clampPage } from './glLineExportService';
import { GL_LINE_EXPORT_SCHEMA_VERSION, str, toNum, type ExportValue } from './glLineExportRows';

export const GL_EXPORT_TABLES = ['lines', 'accounts', 'cost_centres', 'business_units', 'counterparties'] as const;
export type GlExportTable = (typeof GL_EXPORT_TABLES)[number];
export type GlDimensionTable = Exclude<GlExportTable, 'lines'>;

export function isGlExportTable(v: unknown): v is GlExportTable {
  return typeof v === 'string' && (GL_EXPORT_TABLES as readonly string[]).includes(v);
}

/** Keyset position in a dimension table: the last row's kind ('' or Customer / Supplier) and id. */
export type GlTableCursor = readonly [string, string];

/** The only kinds a table cursor can carry; anything else is not a cursor this module made. */
export const GL_TABLE_CURSOR_KINDS: readonly string[] = ['', 'Customer', 'Supplier'];

export interface DimensionTablePage {
  columns: string[];
  rows: Array<Record<string, ExportValue>>;
  next: GlTableCursor | null;
}

const COLUMNS: Record<GlDimensionTable, string[]> = {
  accounts: ['GL_Account_Code', 'GL_Account_Name', 'GL_Account_Type', 'Account_Subtype', 'Account_Class',
    'Account_Category', 'Statement_Line', 'Statement_Group', 'Cash_Class', 'Capex_Opex_Flag', 'Is_Bank',
    'Is_Active', 'Schema_Version'],
  cost_centres: ['CC_ID', 'CC_Level', 'CC_Code', 'CC_Name', 'Parent_Code', 'Aliases', 'Is_Active', 'Schema_Version'],
  business_units: ['BU_ID', 'BU_Code', 'BU_Name', 'BU_Division', 'Is_Active', 'Schema_Version'],
  counterparties: ['Counterparty_ID', 'Counterparty_Name', 'Counterparty_Type', 'VAT_Number', 'Schema_Version'],
};

function toTableRow(table: GlDimensionTable, r: DbRow): Record<string, ExportValue> {
  const v = GL_LINE_EXPORT_SCHEMA_VERSION;
  switch (table) {
    case 'accounts':
      return {
        GL_Account_Code: str(r.account_code), GL_Account_Name: str(r.account_name),
        GL_Account_Type: str(r.account_type), Account_Subtype: str(r.account_subtype),
        Account_Class: str(r.report_class), Account_Category: str(r.report_category),
        Statement_Line: str(r.statement_line), Statement_Group: str(r.statement_group),
        Cash_Class: str(r.cash_class), Capex_Opex_Flag: str(r.capex_opex),
        Is_Bank: r.is_bank === true, Is_Active: r.is_active !== false, Schema_Version: v,
      };
    case 'cost_centres':
      return {
        CC_ID: String(r.id), CC_Level: str(r.cc_type), CC_Code: str(r.code), CC_Name: str(r.name),
        Parent_Code: str(r.parent_code), Aliases: str(r.aliases), Is_Active: r.is_active !== false,
        Schema_Version: v,
      };
    case 'business_units':
      return {
        BU_ID: String(r.id), BU_Code: str(r.code), BU_Name: str(r.name), BU_Division: str(r.division),
        Is_Active: r.is_active !== false, Schema_Version: v,
      };
    case 'counterparties':
      return {
        Counterparty_ID: String(r.id), Counterparty_Name: str(r.name), Counterparty_Type: str(r.type),
        VAT_Number: str(r.vat_number), Schema_Version: v,
      };
  }
}

/** Raw rows of one page; each carries its sort key `k1` (a fixed kind) and text `id`. */
async function fetchTableRows(
  companyId: string,
  table: GlDimensionTable,
  cursor: GlTableCursor | null,
  pageSize: number,
): Promise<DbRow[]> {
  const [c1, cid] = cursor ?? [null, null];
  if (table === 'accounts') {
    return (await sql`
      SELECT * FROM (
        SELECT account_code, account_name, account_type, account_subtype, report_class, report_category,
               statement_line, statement_group, cash_class, capex_opex, is_active,
               (account_subtype = ANY(${CASH_SUBTYPES as string[]}::TEXT[])) AS is_bank,
               ''::TEXT AS k1, id::TEXT AS id
        FROM gl_accounts WHERE company_id = ${companyId}::UUID
      ) t
      WHERE ${cid}::TEXT IS NULL OR (t.k1, t.id) > (${c1}::TEXT, ${cid}::TEXT)
      ORDER BY t.k1, t.id LIMIT ${pageSize}
    `) as DbRow[];
  }
  if (table === 'cost_centres') {
    return (await sql`
      SELECT * FROM (
        SELECT cc.cc_type, cc.code, cc.name, p.code AS parent_code, cc.is_active,
               (SELECT string_agg(a.alias, '|' ORDER BY a.alias) FROM cost_centre_aliases a
                 WHERE a.cost_centre_id = cc.id AND a.company_id = ${companyId}::UUID) AS aliases,
               ''::TEXT AS k1, cc.id::TEXT AS id
        FROM cost_centres cc
        LEFT JOIN cost_centres p ON p.id = cc.parent_id AND p.company_id = ${companyId}::UUID
        WHERE cc.company_id = ${companyId}::UUID
      ) t
      WHERE ${cid}::TEXT IS NULL OR (t.k1, t.id) > (${c1}::TEXT, ${cid}::TEXT)
      ORDER BY t.k1, t.id LIMIT ${pageSize}
    `) as DbRow[];
  }
  if (table === 'business_units') {
    return (await sql`
      SELECT * FROM (
        SELECT code, name, division, is_active,
               ''::TEXT AS k1, id::TEXT AS id
        FROM business_units WHERE company_id = ${companyId}::UUID
      ) t
      WHERE ${cid}::TEXT IS NULL OR (t.k1, t.id) > (${c1}::TEXT, ${cid}::TEXT)
      ORDER BY t.k1, t.id LIMIT ${pageSize}
    `) as DbRow[];
  }
  return (await sql`
    SELECT * FROM (
      SELECT COALESCE(s.company_name, s.name) AS name, 'Supplier' AS type, s.vat_number,
             'Supplier' AS k1, s.id::TEXT AS id
      FROM suppliers s WHERE s.company_id = ${companyId}::UUID
      UNION ALL
      SELECT c.name, 'Customer', c.vat_number, 'Customer', c.id::TEXT
      FROM customers c WHERE c.company_id = ${companyId}::UUID
    ) t
    WHERE ${cid}::TEXT IS NULL OR (t.k1, t.id) > (${c1}::TEXT, ${cid}::TEXT)
    ORDER BY t.k1, t.id LIMIT ${pageSize}
  `) as DbRow[];
}

/** One keyset page of a dimension master, this company's rows only. */
export async function getExportDimensionTablePage(
  companyId: string,
  table: GlDimensionTable,
  cursor: GlTableCursor | null,
  limit: number,
): Promise<DimensionTablePage> {
  const pageSize = clampPage(limit);
  const raw = await fetchTableRows(companyId, table, cursor, pageSize);
  const last = raw[raw.length - 1];
  return {
    columns: COLUMNS[table],
    rows: raw.map((r) => toTableRow(table, r)),
    next: last === undefined || raw.length < pageSize ? null : [String(last.k1), String(last.id)],
  };
}

/** Row count of a dimension master — what paging it to exhaustion yields. */
export async function countExportDimensionTable(companyId: string, table: GlDimensionTable): Promise<number> {
  const rows = (table === 'accounts'
    ? await sql`SELECT COUNT(*) AS n FROM gl_accounts WHERE company_id = ${companyId}::UUID`
    : table === 'cost_centres'
      ? await sql`SELECT COUNT(*) AS n FROM cost_centres WHERE company_id = ${companyId}::UUID`
      : table === 'business_units'
        ? await sql`SELECT COUNT(*) AS n FROM business_units WHERE company_id = ${companyId}::UUID`
        : await sql`
            SELECT (SELECT COUNT(*) FROM suppliers WHERE company_id = ${companyId}::UUID)
                 + (SELECT COUNT(*) FROM customers WHERE company_id = ${companyId}::UUID) AS n
          `) as DbRow[];
  return toNum(rows[0]?.n);
}
