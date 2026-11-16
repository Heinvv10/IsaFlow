/**
 * The MCP budget Excel suites' plumbing: read a version's whole JSON template through get_budget_template (every
 * page, each row with its signed base), edit its rows, and edit an .xlsx template the way a person does in Excel (ExcelJS, independent of the
 * builder under test), by account code and month header.
 */
import type { Pool } from 'pg';
import ExcelJS from 'exceljs';
import type { SetupUser } from './onboardingSetupFixture';
import { body, mcp } from './mcpBudgetFixture';

export interface GridRow { account: string; dimension?: string; base: string; months: Record<string, string | null>; [k: string]: unknown }

/**
 * Every row of the version's JSON template (all pages), each with the signed base it was read with. Pages read at
 * different tokens may be merged: each row carries its own base (review round 1; the old helper returned the last
 * page's token, which the import then trusted for every row). `tokens` lists each page's version_token.
 */
export async function gridRows(pool: Pool, u: SetupUser, versionId: string, grain = 'company', members?: string[], role = 'owner') {
  const rows: GridRow[] = [];
  const tokens: string[] = [];
  let offset: number | null = 0, totals: Record<string, { year: string; months: string[] }> = {};
  while (offset !== null) {
    const page = body(await mcp(pool, u, 'get_budget_template', { version_id: versionId, grain, ...(members ? { members } : {}), limit: 50, offset }, { role }));
    rows.push(...(page.rows as GridRow[]));
    tokens.push(String(page.version_token));
    totals = page.totals as typeof totals;
    offset = page.next_offset as number | null;
  }
  return { rows, tokens, totals };
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

/** Round-trip arithmetic: decimal text ↔ integer cents (signed), and a month's last day. */
export const cents = (text: string): number => Math.round(Number(text) * 100);
export const decimal = (c: number): string => `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
export const lastDay = (month: string): string => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);

/** Every page of get_budget: `account|member code` (member '' at company level) → month → cents. */
export async function budgetOf(pool: Pool, u: SetupUser, versionId: string): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  let offset: number | null = 0;
  while (offset !== null) {
    const page = body(await mcp(pool, u, 'get_budget', { version_id: versionId, limit: 80, offset }));
    for (const r of page.rows as Array<{ account: string; member: string | null; months: Record<string, string> }>) {
      out.set(`${r.account}|${r.member ?? ''}`, new Map(Object.entries(r.months).map(([m, a]) => [m, cents(a)])));
    }
    offset = page.next_offset as number | null;
  }
  return out;
}

/** budget_variance on the version over whole months `from`..`to` (optionally filtered): per account budget and the sections' budgets, in cents. */
export async function varianceOf(pool: Pool, u: SetupUser, versionId: string, from: string, to: string, extra: Record<string, unknown> = {}) {
  const r = body(await mcp(pool, u, 'budget_variance', { period_start: `${from}-01`, period_end: lastDay(to), version_id: versionId, detail: 'full', ...extra }));
  const rows = new Map((r.rows as Array<{ account_code: string; budget_amount: number }>).map((x) => [x.account_code, Math.round(x.budget_amount * 100)]));
  const s = r.sections as Record<'revenue' | 'expense' | 'net_profit', { budget: number }>;
  return { rows, revenue: Math.round(s.revenue.budget * 100), expense: Math.round(s.expense.budget * 100), net: Math.round(s.net_profit.budget * 100) };
}
