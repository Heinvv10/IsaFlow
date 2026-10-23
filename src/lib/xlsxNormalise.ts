/**
 * Rebuild an uploaded .xlsx as a small, trusted zip before anything parses it.
 *
 * Two zip parsers reading the same upload is a parser differential: jszip reads
 * the central directory, ExcelJS's streaming reader walks the local entries
 * from the front, and a crafted zip can show each a different file. So the
 * upload is read ONCE, by jszip, and every entry the conversion needs is
 * inflated with its bytes counted against one budget (the sizes a zip declares
 * can lie). Those bytes are written into a fresh zip, stored uncompressed and
 * in the order ExcelJS needs them (rels, workbook, styles, shared strings, then
 * the first sheet as `xl/worksheets/sheet1.xml`), and only that zip reaches
 * ExcelJS. Shared strings and rels always precede the sheet (an empty table or
 * rel list is written when the upload has none), so the streaming reader never
 * defers the sheet to a temp file.
 *
 * Server-side only.
 */
import JSZip from 'jszip';
import { SpreadsheetMalformedError, SpreadsheetTooLargeError } from './spreadsheetErrors';

const EMPTY_SHARED_STRINGS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>';
const EMPTY_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';

const tooLarge = (maxBytes: number) => new SpreadsheetTooLargeError(
  `This workbook is too large to import (over ${Math.round(maxBytes / 1024 / 1024)} MB once opened). Save the sheet you need as CSV, or split it, and upload again.`,
);

/** Inflate one entry, counting against what is left of the budget; stops at the first byte past it. */
function inflate(file: JSZip.JSZipObject, budget: { left: number; max: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const stream = file.nodeStream('nodebuffer');
    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      budget.left -= chunk.length;
      if (budget.left < 0) {
        settled = true;
        stream.pause();
        stream.removeAllListeners('data');
        chunks.length = 0;
        reject(tooLarge(budget.max));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    stream.on('error', (err: Error) => { if (!settled) { settled = true; reject(err); } });
  });
}

/** The attributes of one XML start tag, by local name (`r:id` → `id`). */
function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]!.replace(/^[\w.-]+:/, '')] = m[2]!;
  return out;
}

/** The zip path of the workbook's first sheet, from workbook.xml and its rels; null if they do not say. */
function firstSheetPath(workbookXml: string, relsXml: string | null): string | null {
  const sheet = /<(?:[\w.-]+:)?sheet\b[^>]*>/.exec(workbookXml);
  const relId = sheet ? attributes(sheet[0]).id : undefined;
  if (!relId || !relsXml) return null;
  for (const m of relsXml.matchAll(/<(?:[\w.-]+:)?Relationship\b[^>]*>/g)) {
    const a = attributes(m[0]);
    if (a.Id !== relId || !a.Target) continue;
    return a.Target.startsWith('/') ? a.Target.slice(1) : `xl/${a.Target.replace(/^\.\//, '')}`;
  }
  return null;
}

/** The lowest-numbered sheet, when the workbook does not name its first. */
function lowestSheetPath(zip: JSZip): string | null {
  const sheets = Object.keys(zip.files)
    .map(p => ({ p, n: /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(p)?.[1] }))
    .filter((s): s is { p: string; n: string } => s.n !== undefined)
    .sort((a, b) => Number(a.n) - Number(b.n));
  return sheets[0]?.p ?? null;
}

/**
 * The normalised zip, or null when the workbook has no sheet. Throws
 * SpreadsheetTooLargeError past `maxBytes` inflated, SpreadsheetMalformedError
 * when it is not a workbook at all.
 */
export async function normaliseXlsx(buf: Buffer, maxBytes: number): Promise<Buffer | null> {
  const zip = await JSZip.loadAsync(buf); // the central directory only; nothing is inflated yet
  const budget = { left: maxBytes, max: maxBytes };
  const read = async (path: string): Promise<Buffer | null> => {
    const file = zip.file(path);
    return file && !file.dir ? inflate(file, budget) : null;
  };

  const workbook = await read('xl/workbook.xml');
  if (!workbook) throw new SpreadsheetMalformedError('This file is not an Excel workbook (.xlsx). Save it as .xlsx or CSV and upload again.');
  const rels = await read('xl/_rels/workbook.xml.rels');
  const named = firstSheetPath(workbook.toString('utf8'), rels?.toString('utf8') ?? null);
  const sheetPath = named && zip.file(named) ? named : lowestSheetPath(zip);
  if (!sheetPath) return null;
  const styles = await read('xl/styles.xml');
  const shared = await read('xl/sharedStrings.xml');
  const sheet = await read(sheetPath);
  if (!sheet) return null;

  const out = new JSZip();
  out.file('xl/_rels/workbook.xml.rels', rels ?? EMPTY_RELS);
  out.file('xl/workbook.xml', workbook);
  if (styles) out.file('xl/styles.xml', styles);
  out.file('xl/sharedStrings.xml', shared ?? EMPTY_SHARED_STRINGS);
  out.file('xl/worksheets/sheet1.xml', sheet);
  return out.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}
