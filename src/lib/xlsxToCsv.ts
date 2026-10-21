/**
 * Turn the first worksheet of an .xlsx workbook into CSV text.
 *
 * The external migration wizard accepted .xlsx but read every upload as UTF-8
 * text, so a workbook reached the CSV parser as zip bytes and parsed as
 * nothing. Converting to CSV lets the existing per-source parsers read it
 * unchanged. Uses exceljs, already a dependency. Server-side only.
 *
 * An .xlsx is a zip, and a 10 MB upload can inflate to gigabytes. Nothing here
 * parses the upload itself: xlsxNormalise rebuilds it (inflated bytes counted)
 * into a small trusted zip, and only that reaches ExcelJS's STREAMING reader,
 * which holds the shared strings and one row at a time. Rows are counted by
 * this code (a sheet's own row numbers are not trusted: missing or
 * non-increasing ones are refused), columns are capped per row, and the CSV
 * being written has a byte budget, so one long shared string repeated in every
 * cell cannot multiply into gigabytes. Each limit refuses with a
 * SpreadsheetRefusedError, whose message is for the client.
 */
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { normaliseXlsx } from './xlsxNormalise';
import { SpreadsheetMalformedError, SpreadsheetTooLargeError } from './spreadsheetErrors';

export { SpreadsheetMalformedError, SpreadsheetRefusedError, SpreadsheetTooLargeError } from './spreadsheetErrors';

export interface XlsxLimits {
  /** Everything read from the workbook, inflated. */
  maxUncompressedBytes: number;
  maxRows: number;
  maxColumns: number;
  /** The CSV produced. */
  maxOutputBytes: number;
}

/** Far beyond any chart, contact list or trial balance a business exports. */
export const XLSX_LIMITS: XlsxLimits = {
  maxUncompressedBytes: 80 * 1024 * 1024, maxRows: 50_000, maxColumns: 100, maxOutputBytes: 40 * 1024 * 1024,
};

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

/**
 * The first sheet, streamed from the normalised zip; the read stops at the
 * first row, column or output byte past a limit. Cells are kept as text and
 * padded to the widest row at the end, as the CSV parsers expect.
 */
export async function xlsxBufferToCsv(buf: Buffer, limits: XlsxLimits = XLSX_LIMITS): Promise<string> {
  const normalised = await normaliseXlsx(buf, limits.maxUncompressedBytes);
  if (!normalised) return '';
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([normalised]), {
    worksheets: 'emit', sharedStrings: 'cache', styles: 'cache', hyperlinks: 'ignore', entries: 'ignore',
  });
  const rows: string[][] = [];
  let width = 0;
  let count = 0;
  let lastNumber = 0;
  let output = 0;
  for await (const sheet of reader) {
    for await (const row of sheet) {
      if (!Number.isInteger(row.number) || row.number <= lastNumber) {
        throw new SpreadsheetMalformedError('This workbook\'s rows are out of order, which Excel never writes. Open it in Excel, save it again, and upload it.');
      }
      lastNumber = row.number;
      if (++count > limits.maxRows) {
        throw new SpreadsheetTooLargeError(`The first sheet has more than ${limits.maxRows} rows; IsaFlow imports at most ${limits.maxRows} at a time. Split the file and upload each part.`);
      }
      if (row.cellCount > limits.maxColumns) {
        throw new SpreadsheetTooLargeError(`The first sheet has more than ${limits.maxColumns} columns; IsaFlow reads at most ${limits.maxColumns}. Remove the columns you do not need and upload again.`);
      }
      // A blank row is dropped, as parseMigrationCsv drops a blank CSV line: a
      // "Row N" message counts non-blank rows under the header, for both.
      if (!row.hasValues) continue;
      const cells: string[] = [];
      for (let c = 1; c <= row.cellCount; c++) {
        const field = csvField(cellText(row.getCell(c).value));
        output += field.length + 1;
        if (output > limits.maxOutputBytes) {
          throw new SpreadsheetTooLargeError(`The first sheet holds more than ${Math.round(limits.maxOutputBytes / 1024 / 1024)} MB of text once read. Split the file and upload each part.`);
        }
        cells.push(field);
      }
      rows.push(cells);
      width = Math.max(width, cells.length);
    }
    break; // the normalised zip holds the first sheet only
  }
  return rows.map(cells => [...cells, ...Array<string>(width - cells.length).fill('')].join(',')).join('\n');
}
