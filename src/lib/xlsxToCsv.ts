/**
 * Turn the first worksheet of an .xlsx workbook into CSV text.
 *
 * The external migration wizard accepted .xlsx but read every upload as UTF-8
 * text, so a workbook reached the CSV parser as zip bytes and parsed as
 * nothing. Converting to CSV lets the existing per-source parsers read it
 * unchanged. Uses exceljs, already a dependency. Server-side only.
 */
import ExcelJS from 'exceljs';

/** An .xlsx is a zip: it starts with the local-file-header signature "PK\x03\x04". */
export function looksLikeXlsx(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  if (typeof value === 'object') {
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue); // formula
    if ('richText' in value) return value.richText.map(t => t.text).join('');
    if ('text' in value) return String(value.text); // hyperlink
    if ('error' in value) return '';
    return '';
  }
  return String(value);
}

function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function xlsxBufferToCsv(buf: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return '';
  const width = ws.columnCount;
  const lines: string[] = [];
  ws.eachRow({ includeEmpty: false }, row => {
    const cells: string[] = [];
    for (let c = 1; c <= width; c++) cells.push(csvField(cellText(row.getCell(c).value)));
    lines.push(cells.join(','));
  });
  return lines.join('\n');
}
