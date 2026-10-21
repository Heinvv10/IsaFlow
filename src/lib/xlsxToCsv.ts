/**
 * Turn the first worksheet of an .xlsx workbook into CSV text.
 *
 * The external migration wizard accepted .xlsx but read every upload as UTF-8
 * text, so a workbook reached the CSV parser as zip bytes and parsed as
 * nothing. Converting to CSV lets the existing per-source parsers read it
 * unchanged. Uses exceljs, already a dependency. Server-side only.
 *
 * An .xlsx is a zip: a 10 MB upload can inflate to gigabytes. Before ExcelJS
 * loads it, every entry is inflated through jszip and COUNTED (the sizes a zip
 * declares can lie), and the first sheet's rows and columns are capped. Each
 * limit refuses with SpreadsheetTooLargeError, whose message is for the client.
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

export interface XlsxLimits {
  /** Everything in the workbook, inflated. */
  maxUncompressedBytes: number;
  maxRows: number;
  maxColumns: number;
}

/** Far beyond any chart, contact list or trial balance a business exports. */
export const XLSX_LIMITS: XlsxLimits = { maxUncompressedBytes: 80 * 1024 * 1024, maxRows: 50_000, maxColumns: 100 };

export class SpreadsheetTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadsheetTooLargeError';
  }
}

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
    return ''; // an error cell, or a shape this importer has no text for
  }
  return String(value);
}

function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const tooLarge = (maxBytes: number) => new SpreadsheetTooLargeError(
  `This workbook is too large to import (over ${Math.round(maxBytes / 1024 / 1024)} MB once opened). Save the sheet you need as CSV, or split it, and upload again.`,
);

/** Inflate one entry, counting; `budget` is what is left. Stops at the first byte past it. */
function inflatedSize(file: JSZip.JSZipObject, budget: number, maxBytes: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const stream = file.nodeStream('nodebuffer');
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > budget && !settled) {
        settled = true;
        stream.pause();
        stream.removeAllListeners('data');
        reject(tooLarge(maxBytes));
      }
    });
    stream.on('end', () => { if (!settled) { settled = true; resolve(size); } });
    stream.on('error', (err: Error) => { if (!settled) { settled = true; reject(err); } });
  });
}

/** Every entry inflated and counted against one budget, before anything parses the XML. */
async function assertInflatesWithin(buf: Buffer, maxBytes: number): Promise<void> {
  const zip = await JSZip.loadAsync(buf); // reads the central directory; nothing is inflated yet
  let left = maxBytes;
  for (const file of Object.values(zip.files)) {
    if (!file.dir) left -= await inflatedSize(file, left, maxBytes);
  }
}

export async function xlsxBufferToCsv(buf: Buffer, limits: XlsxLimits = XLSX_LIMITS): Promise<string> {
  await assertInflatesWithin(buf, limits.maxUncompressedBytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return '';
  if (ws.rowCount > limits.maxRows) {
    throw new SpreadsheetTooLargeError(`The first sheet has ${ws.rowCount} rows; IsaFlow imports at most ${limits.maxRows} at a time. Split the file and upload each part.`);
  }
  const width = ws.columnCount;
  if (width > limits.maxColumns) {
    throw new SpreadsheetTooLargeError(`The first sheet has ${width} columns; IsaFlow reads at most ${limits.maxColumns}. Remove the columns you do not need and upload again.`);
  }
  const lines: string[] = [];
  ws.eachRow({ includeEmpty: false }, row => {
    const cells: string[] = [];
    for (let c = 1; c <= width; c++) cells.push(csvField(cellText(row.getCell(c).value)));
    lines.push(cells.join(','));
  });
  return lines.join('\n');
}
