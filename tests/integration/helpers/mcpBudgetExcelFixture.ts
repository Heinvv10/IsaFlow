/**
 * The MCP budget Excel suites' plumbing: read a version's whole JSON template through get_budget_template (every
 * page), edit its rows, and edit an .xlsx template the way a person does in Excel (ExcelJS, independent of the
 * builder under test), by account code and month header.
 */
import type { Pool } from 'pg';
import ExcelJS from 'exceljs';
import type { SetupUser } from './onboardingSetupFixture';
import { body, mcp } from './mcpBudgetFixture';

export interface GridRow { account: string; dimension?: string; months: Record<string, string | null>; [k: string]: unknown }

/** Every row of the version's JSON template (all pages) and its version_token. */
export async function gridRows(pool: Pool, u: SetupUser, versionId: string, grain = 'company', members?: string[], role = 'owner') {
  const rows: GridRow[] = [];
  let offset: number | null = 0, token = '', totals: Record<string, { year: string; months: string[] }> = {};
  while (offset !== null) {
    const page = body(await mcp(pool, u, 'get_budget_template', { version_id: versionId, grain, ...(members ? { members } : {}), limit: 80, offset }, { role }));
    rows.push(...(page.rows as GridRow[]));
    token = String(page.version_token);
    totals = page.totals as typeof totals;
    offset = page.next_offset as number | null;
  }
  return { rows, token, totals };
}

/** Every month of the year, null unless set. */
export const monthsOf = (months: readonly string[], set: Record<string, string | null> = {}) =>
  Object.fromEntries(months.map((m) => [m, m in set ? set[m]! : null]));

export function setMonth(rows: GridRow[], account: string, month: string, amount: string | null, dimension?: string): void {
  const row = rows.find((r) => r.account === account && (dimension === undefined || r.dimension === dimension));
  if (!row) throw new Error(`No template row for ${account}${dimension ? `/${dimension}` : ''}`);
  row.months[month] = amount;
}

export interface SheetEdit { set(account: string, month: string, value: ExcelJS.CellValue): void; sheet: ExcelJS.Worksheet }

/** The base64 .xlsx edited in its Budget sheet, back as base64. */
export async function editXlsx(base64: string, edit: (ws: SheetEdit) => void): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(base64, 'base64') as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Budget')!;
  const col = (header: string) => {
    let at = 0;
    ws.getRow(1).eachCell((c, n) => { if (String(c.value) === header) at = n; });
    if (!at) throw new Error(`No column ${header}`);
    return at;
  };
  const rowOf = (account: string) => {
    const a = col('Account code');
    for (let r = 2; r <= ws.rowCount; r++) if (String(ws.getRow(r).getCell(a).value ?? '') === account) return r;
    throw new Error(`No row ${account}`);
  };
  edit({ sheet: ws, set: (account, month, value) => { ws.getRow(rowOf(account)).getCell(col(month)).value = value; } });
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}
