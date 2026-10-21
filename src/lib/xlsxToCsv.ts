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
 * declares can lie), and the first sheet is streamed with its rows and columns
 * capped as it is read. Each
 * limit refuses with SpreadsheetTooLargeError, whose message is for the client.
 */
import { Readable } from 'node:stream';
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

/**
 * The first sheet, STREAMED: ExcelJS's WorkbookReader holds the shared strings
 * and one row at a time, never the whole model, and the read stops at the
 * first row or column past a cap — so the caps bound memory, not only the
 * answer. Cells are kept as text (at most maxRows x maxColumns of them) and
 * padded to the widest row at the end, as the CSV parsers expect.
 */
export async function xlsxBufferToCsv(buf: Buffer, limits: XlsxLimits = XLSX_LIMITS): Promise<string> {
  await assertInflatesWithin(buf, limits.maxUncompressedBytes);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([buf]), {
    worksheets: 'emit', sharedStrings: 'cache', styles: 'cache', hyperlinks: 'ignore', entries: 'ignore',
  });
  const rows: string[][] = [];
  let width = 0;
  for await (const sheet of reader) {
    for await (const row of sheet) {
      if (row.number > limits.maxRows) {
        throw new SpreadsheetTooLargeError(`The first sheet has more than ${limits.maxRows} rows; IsaFlow imports at most ${limits.maxRows} at a time. Split the file and upload each part.`);
      }
      if (row.cellCount > limits.maxColumns) {
        throw new SpreadsheetTooLargeError(`The first sheet has more than ${limits.maxColumns} columns; IsaFlow reads at most ${limits.maxColumns}. Remove the columns you do not need and upload again.`);
      }
      if (!row.hasValues) continue;
      const cells: string[] = [];
      for (let c = 1; c <= row.cellCount; c++) cells.push(csvField(cellText(row.getCell(c).value)));
      rows.push(cells);
      width = Math.max(width, cells.length);
    }
    break; // the first sheet only
  }
  return rows.map(cells => [...cells, ...Array<string>(width - cells.length).fill('')].join(',')).join('\n');
}
