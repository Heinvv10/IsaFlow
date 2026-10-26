/**
 * Budget-grid Excel round-trip plumbing (budgets P2 PR-B, T9): download the real template through
 * its route, edit the workbook the way a user would in Excel (ExcelJS, independent of the builder
 * under test), upload it to the real import-preview route (JSON, the file as base64), and a zip bomb.
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { response } from '../mfa-impersonation-postgres.helpers';
import type { SetupUser } from './onboardingSetupFixture';
import type { RouteOut } from './budgetGridFixture';

const CSRF = 'disposable-postgres-workflow-csrf-0123456789';
type Route = (req: never, res: never) => Promise<unknown>;

function cookieHeaders(u: SetupUser) {
  const cookies = { 'sb-access-token': u.token, active_company_id: u.homeCompanyId, isaflow_csrf: CSRF };
  return { cookies, cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') };
}

/** GET the template; `body` is the workbook bytes on 200, the JSON envelope otherwise. */
export async function downloadTemplate(route: unknown, u: SetupUser, query: Record<string, string>) {
  const { cookies, cookie } = cookieHeaders(u);
  const req = { method: 'GET', url: '/api/accounting/budget-grid/template', cookies, query, headers: { cookie }, socket: { remoteAddress: '127.0.0.91' } };
  const out = response();
  await (route as Route)(req as never, out.res as never);
  const body = out.state.body;
  return {
    status: out.state.statusCode, headers: out.headers,
    file: Buffer.isBuffer(body) || body instanceof Uint8Array ? Buffer.from(body as Uint8Array) : null,
    json: Buffer.isBuffer(body) ? null : (body as RouteOut['body']),
  };
}

/** POST the file (as base64 JSON, the route's shape) and `versionId` to import-preview as `u`; `extra` is merged into the body. */
export async function uploadPreview(route: unknown, u: SetupUser, versionId: string, file: Buffer, extra: Record<string, unknown> = {}): Promise<RouteOut> {
  return postPreview(route, u, { versionId, fileName: 'budget.xlsx', fileData: file.toString('base64'), ...extra });
}

/** POST any JSON body to import-preview as `u` (CSRF header and cookies as a browser sends them). */
export async function postPreview(route: unknown, u: SetupUser, body: unknown, opts: { csrf?: string | null } = {}): Promise<RouteOut & { headers: Map<string, unknown> }> {
  const { cookies, cookie } = cookieHeaders(u);
  const csrf = opts.csrf === undefined ? CSRF : opts.csrf;
  const req = {
    method: 'POST', url: '/api/accounting/budget-grid/import-preview', cookies, query: {}, body,
    headers: { 'content-type': 'application/json', cookie, ...(csrf === null ? {} : { 'x-csrf-token': csrf }) },
    socket: { remoteAddress: '127.0.0.92' },
  };
  const out = response();
  await (route as Route)(req as never, out.res as never);
  return { status: out.state.statusCode, body: (out.state.body ?? {}) as RouteOut['body'], headers: out.headers };
}

/** Load, edit, write back: what a user does in Excel. */
export async function editWorkbook(file: Buffer, edit: (wb: ExcelJS.Workbook) => void | Promise<void>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file as unknown as ArrayBuffer);
  await edit(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const budgetSheet = (wb: ExcelJS.Workbook): ExcelJS.Worksheet => wb.getWorksheet('Budget')!;
export const baseSheet = (wb: ExcelJS.Workbook): ExcelJS.Worksheet => wb.getWorksheet('_base')!;

/** Replace or add zip parts of `file` (`null` removes one): edits Excel would never make. */
export async function withParts(file: Buffer, parts: Record<string, string | null | ((xml: string) => string)>): Promise<Buffer> {
  const zip = await JSZip.loadAsync(file);
  for (const [path, body] of Object.entries(parts)) {
    if (body === null) zip.remove(path);
    else zip.file(path, typeof body === 'function' ? body(await zip.file(path)!.async('string')) : body);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

/** The 1-based column whose header (row 1) reads `text`. */
export function col(ws: ExcelJS.Worksheet, text: string): number {
  let found = 0;
  ws.getRow(1).eachCell((cell, n) => { if (String(cell.value).trim() === text) found = n; });
  if (!found) throw new Error(`No column headed ${text}`);
  return found;
}

/** The 1-based row of an account code (and dimension code, at a dimension grain). */
export function rowOf(ws: ExcelJS.Worksheet, accountCode: string, dimCode?: string): number {
  const a = col(ws, 'Account code');
  const d = dimCode === undefined ? 0 : col(ws, 'Dimension code');
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (String(row.getCell(a).value ?? '') === accountCode && (d === 0 || String(row.getCell(d).value ?? '') === dimCode)) return r;
  }
  throw new Error(`No row for ${accountCode}${dimCode ? `/${dimCode}` : ''}`);
}

export function setCell(ws: ExcelJS.Worksheet, accountCode: string, header: string, value: ExcelJS.CellValue, dimCode?: string): void {
  ws.getRow(rowOf(ws, accountCode, dimCode)).getCell(col(ws, header)).value = value;
}

export function cellValue(ws: ExcelJS.Worksheet, accountCode: string, header: string, dimCode?: string): ExcelJS.CellValue {
  return ws.getRow(rowOf(ws, accountCode, dimCode)).getCell(col(ws, header)).value;
}

/** Swap two whole columns, header included (values travel with their header). */
export function swapColumns(ws: ExcelJS.Worksheet, a: number, b: number): void {
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const va = row.getCell(a).value;
    row.getCell(a).value = row.getCell(b).value;
    row.getCell(b).value = va;
  }
}

/** A workbook whose one sheet inflates past `inflatedMb` from a few kB upload. */
export async function zipBomb(inflatedMb: number): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="_meta" sheetId="2" r:id="rId2"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>');
  const pad = ' '.repeat(inflatedMb * 1024 * 1024);
  zip.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${pad}</sheetData></worksheet>`);
  zip.file('xl/worksheets/sheet2.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${pad}</sheetData></worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}
